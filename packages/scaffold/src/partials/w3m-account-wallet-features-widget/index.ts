import {
  AccountController,
  ModalController,
  NetworkController,
  AssetUtil,
  RouterController
} from '@web3modal/core'
import { customElement } from '@web3modal/ui'
import { LitElement, html } from 'lit'
import { state } from 'lit/decorators.js'
import { ifDefined } from 'lit/directives/if-defined.js'
import styles from './styles.js'
import { ConstantsUtil } from '../../utils/ConstantsUtil.js'
import { W3mFrameHelpers } from '@web3modal/wallet'

@customElement('w3m-account-wallet-features-widget')
export class W3mAccountWalletFeaturesWidget extends LitElement {
  public static override styles = styles

  // -- Members ------------------------------------------- //
  private unsubscribe: (() => void)[] = []

  // -- State & Properties -------------------------------- //
  @state() private address = AccountController.state.address

  @state() private profileImage = AccountController.state.profileImage

  @state() private profileName = AccountController.state.profileName

  @state() private smartAccountDeployed = AccountController.state.smartAccountDeployed

  @state() private network = NetworkController.state.caipNetwork

  public constructor() {
    super()
    this.unsubscribe.push(
      ...[
        AccountController.subscribe(val => {
          if (val.address) {
            this.address = val.address
            this.profileImage = val.profileImage
            this.profileName = val.profileName
            this.smartAccountDeployed = val.smartAccountDeployed
          } else {
            ModalController.close()
          }
        })
      ],
      NetworkController.subscribe(val => {
        this.network = val.caipNetwork
      })
    )
  }

  public override disconnectedCallback() {
    this.unsubscribe.forEach(unsubscribe => unsubscribe())
  }

  // -- Render -------------------------------------------- //
  public override render() {
    if (!this.address) {
      throw new Error('w3m-account-view: No account provided')
    }

    const networkImage = AssetUtil.getNetworkImage(this.network)

    return html`<wui-flex
      flexDirection="column"
      .padding=${['0', 'xl', 'm', 'xl'] as const}
      alignItems="center"
      gap="l"
    >
      ${this.activateAccountTemplate()}
      <wui-profile-button
        @click=${this.onProfileButtonClick.bind(this)}
        address=${ifDefined(this.address)}
        networkSrc=${ifDefined(networkImage)}
        icon="chevronBottom"
        avatarSrc=${ifDefined(this.profileImage ? this.profileImage : undefined)}
        ?isprofilename=${Boolean(this.profileName)}
      ></wui-profile-button>
      <wui-balance dollars="0" pennies="00"></wui-balance>
      <wui-flex gap="s">
        <wui-tooltip-select
          @click=${this.onBuyClick.bind(this)}
          text="Buy"
          icon="card"
        ></wui-tooltip-select>
        <wui-tooltip-select text="Convert" icon="recycleHorizontal"></wui-tooltip-select>
        <wui-tooltip-select
          @click=${this.onReceiveClick.bind(this)}
          text="Receive"
          icon="arrowBottomCircle"
        ></wui-tooltip-select>
        <wui-tooltip-select text="Send" icon="send"></wui-tooltip-select>
      </wui-flex>

      <wui-tabs localTabWidth="120px" .tabs=${ConstantsUtil.ACCOUNT_TABS}></wui-tabs>
    </wui-flex>`
  }

  // -- Private ------------------------------------------- //
  private activateAccountTemplate() {
    const preferredAccountType = W3mFrameHelpers.getPreferredAccountType()
    const smartAccountEnabled = NetworkController.checkIfSmartAccountEnabled()
    if (
      !smartAccountEnabled ||
      preferredAccountType === 'smartAccount' ||
      this.smartAccountDeployed
    ) {
      return null
    }

    return html` <wui-promo
      text=${'Activate your account'}
      @click=${() => RouterController.push('UpgradeToSmartAccount')}
    ></wui-promo>`
  }

  private onProfileButtonClick() {
    RouterController.push('AccountSettings')
  }

  private onBuyClick() {
    RouterController.push('OnRampProviders')
  }

  private onReceiveClick() {
    RouterController.push('WalletReceive')
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'w3m-account-wallet-features-widget': W3mAccountWalletFeaturesWidget
  }
}
