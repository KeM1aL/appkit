/* eslint-disable no-console */
import type { Config, GetAccountReturnType, GetEnsAddressReturnType } from '@wagmi/core'
import {
  connect,
  disconnect,
  getAccount,
  getBalance,
  getConnections,
  getEnsName,
  prepareTransactionRequest,
  reconnect,
  signMessage,
  switchAccount,
  switchChain,
  estimateGas as wagmiEstimateGas,
  getEnsAddress as wagmiGetEnsAddress,
  getEnsAvatar as wagmiGetEnsAvatar,
  sendTransaction as wagmiSendTransaction,
  writeContract as wagmiWriteContract,
  waitForTransactionReceipt,
  watchAccount,
  watchConnectors
} from '@wagmi/core'
import type { Chain } from '@wagmi/core/chains'
import { EthereumProvider, OPTIONAL_METHODS } from '@walletconnect/ethereum-provider'
import type { Chain as AvailableChain, CaipNetworkId } from '@web3modal/common'
import {
  ConstantsUtil as CommonConstants,
  ConstantsUtil as CommonConstantsUtil,
  NetworkUtil
} from '@web3modal/common'
import type {
  CaipAddress,
  CaipNetwork, ChainAdapter, ConnectionControllerClient,
  Connector,
  NetworkControllerClient,
  OptionsControllerState,
  PublicStateControllerState,
  SendTransactionArgs,
  SocialProvider,
  WriteContractArgs,
} from '@web3modal/core'
import { ConstantsUtil, HelpersUtil, PresetsUtil } from '@web3modal/scaffold-utils'
import type { W3mFrameProvider, W3mFrameTypes } from '@web3modal/wallet'
import { W3mFrameHelpers, W3mFrameRpcConstants } from '@web3modal/wallet'
import type { Hex } from 'viem'
import { formatUnits, parseUnits } from 'viem'
import { mainnet } from 'viem/chains'
import { normalize } from 'viem/ens'
import type { AppKit } from '../../../src/client.js'
import type { AppKitOptions } from '../../../utils/TypesUtil.js'
import {
  getCaipDefaultChain,
  getEmailCaipNetworks,
  getWalletConnectCaipNetworks,
  requireCaipAddress
} from './utils/helpers.js'

// -- Types ---------------------------------------------------------------------
export interface AdapterOptions<C extends Config>
  extends Pick<AppKitOptions, 'siweConfig' | 'enableEIP6963'> {
  wagmiConfig: C
  defaultChain?: Chain
}

// @ts-expect-error: Overridden state type is correct
interface Web3ModalState extends PublicStateControllerState {
  selectedNetworkId: number | undefined
}

// -- Client --------------------------------------------------------------------
export class EVMWagmiClient implements ChainAdapter {
  // -- Private variables -------------------------------------------------------
  private appKit: AppKit | undefined = undefined

  private wagmiConfig: AdapterOptions<Config>['wagmiConfig']

  // -- Public variables --------------------------------------------------------
  public options: AppKitOptions | undefined = undefined

  public chain: AvailableChain = CommonConstantsUtil.CHAIN.EVM

  public networkControllerClient: NetworkControllerClient

  public connectionControllerClient: ConnectionControllerClient

  public defaultChain: CaipNetwork | undefined = undefined

  public tokens = HelpersUtil.getCaipTokens(this.options?.tokens)

  public getCaipDefaultChain = this.options?.defaultChain

  public siweControllerClient = this.options?.siweConfig

  public constructor(options: AdapterOptions<Config>) {
    const { wagmiConfig, defaultChain } = options

    if (!wagmiConfig) {
      throw new Error('wagmiConfig is undefined')
    }

    this.wagmiConfig = wagmiConfig
    this.defaultChain = getCaipDefaultChain(defaultChain)
    this.siweControllerClient = options.siweConfig

    this.networkControllerClient = {
      switchCaipNetwork: async caipNetwork => {
        const chainId = NetworkUtil.caipNetworkIdToNumber(caipNetwork?.id)

        if (chainId) {
          await switchChain(this.wagmiConfig, { chainId })
        }
      },

      getApprovedCaipNetworksData: async () =>
        new Promise(resolve => {
          const connections = new Map(this.wagmiConfig.state.connections)
          const connection = connections.get(this.wagmiConfig.state.current || '')

          if (connection?.connector?.id === ConstantsUtil.AUTH_CONNECTOR_ID) {
            resolve(getEmailCaipNetworks())
          } else if (connection?.connector?.id === ConstantsUtil.WALLET_CONNECT_CONNECTOR_ID) {
            const connector = this.wagmiConfig.connectors.find(
              c => c.id === ConstantsUtil.WALLET_CONNECT_CONNECTOR_ID
            )

            resolve(getWalletConnectCaipNetworks(connector))
          }

          resolve({ approvedCaipNetworkIds: undefined, supportsAllNetworks: true })
        })
    }

    this.connectionControllerClient = {
      connectWalletConnect: async onUri => {
        const connector = this.wagmiConfig.connectors.find(
          c => c.id === ConstantsUtil.WALLET_CONNECT_CONNECTOR_ID
        )

        if (!connector) {
          throw new Error('connectionControllerClient:getWalletConnectUri - connector is undefined')
        }

        const provider = (await connector.getProvider()) as Awaited<
          ReturnType<(typeof EthereumProvider)['init']>
        >

        provider.on('display_uri', data => {
          onUri(data)
        })

        const clientId = await provider.signer?.client?.core?.crypto?.getClientId()
        if (clientId) {
          this.appKit?.setClientId(clientId)
        }

        let chainId = NetworkUtil.caipNetworkIdToNumber(this.appKit?.getCaipNetwork()?.id)
        let address: string | undefined = undefined
        let isSuccessful1CA = false

        const supports1ClickAuth = this.appKit?.getIsSiweEnabled() && typeof provider?.authenticate === 'function'
        // Make sure client uses ethereum provider version that supports `authenticate`
        if (supports1ClickAuth) {
          const { SIWEController, getDidChainId, getDidAddress } = await import('@web3modal/siwe')
          if (!SIWEController.state._client) {
            return
          }
          const params = await SIWEController?.getMessageParams?.()
          /*
           * Must perform these checks to satify optional types
           * Make active chain first in requested chains to make it default for siwe message
           */
          if (!params || !Object.keys(params || {}).length) {
            return
          }

          let reorderedChains = this.wagmiConfig.chains.map(c => c.id)
          // @ts-expect-error - setting requested chains beforehand avoids wagmi auto disconnecting the session when `connect` is called because it thinks chains are stale
          await connector.setRequestedChainsIds(reorderedChains)

          if (chainId) {
            reorderedChains = [chainId, ...reorderedChains.filter(c => c !== chainId)]
          }

          SIWEController.setIs1ClickAuthenticating(true)
          const result = await provider.authenticate({
            nonce: await SIWEController.getNonce(),
            methods: [...OPTIONAL_METHODS],
            ...params,
            chains: reorderedChains
          })
          // Auths is an array of signed CACAO objects https://github.com/ChainAgnostic/CAIPs/blob/main/CAIPs/caip-74.md
          const signedCacao = result?.auths?.[0]

          if (signedCacao) {
            const { p, s } = signedCacao
            const cacaoChainId = getDidChainId(p.iss) || ''
            address = getDidAddress(p.iss)
            chainId = parseInt(cacaoChainId, 10)
            // Optimistically set the session to avoid a flash of the wrong state
            if (address && cacaoChainId) {
              SIWEController.setSession({
                address,
                chainId
              })
            }
            SIWEController.setStatus('authenticating')

            try {
              // Kicks off verifyMessage and populates external states
              const message = provider.signer.client.formatAuthMessage({
                request: p,
                iss: p.iss
              })

              await SIWEController.verifyMessage({
                message,
                signature: s.s,
                cacao: signedCacao,
                clientId
              })
              isSuccessful1CA = true

            } catch (error) {
              isSuccessful1CA = false
              SIWEController.setIs1ClickAuthenticating(false)
              // eslint-disable-next-line no-console
              console.error('Error verifying message', error)
              await provider.disconnect().catch(console.error)
              await this.connectionControllerClient.disconnect().catch(console.error)

              SIWEController.setStatus('error')
              throw error
            }
          }
          /*
           * Unassign the connector from the wagmiConfig and allow connect() to reassign it in the next step
           * this avoids case where wagmi throws because the connector is already connected
           * what we need connect() to do is to only setup internal event listeners
           */
          this.wagmiConfig.setState(x => ({
            ...x,
            current: null,
          }))
          SIWEController.setIs1ClickAuthenticating(false)
        }
        await connect(this.wagmiConfig, { connector, chainId })
        const { SIWEController } = await import('@web3modal/siwe')
        if(supports1ClickAuth && address && chainId && isSuccessful1CA){
          SIWEController.setStatus('authenticating')
          await SIWEController.onSignIn?.({
            address,
            chainId
          })
          SIWEController.setStatus('success')
        }
      },

      connectExternal: async ({ id, provider, info }) => {
        const connector = this.wagmiConfig.connectors.find(c => c.id === id)

        if (!connector) {
          throw new Error('connectionControllerClient:connectExternal - connector is undefined')
        }

        this.appKit?.setClientId(null)

        if (provider && info && connector.id === ConstantsUtil.EIP6963_CONNECTOR_ID) {
          // @ts-expect-error Exists on EIP6963Connector
          connector.setEip6963Wallet?.({ provider, info })
        }

        const chainId = NetworkUtil.caipNetworkIdToNumber(this.appKit?.getCaipNetwork()?.id)

        await connect(this.wagmiConfig, { connector, chainId })
      },

      checkInstalled: ids => {
        const injectedConnector = this.appKit
          ?.getConnectors()
          .find((c: Connector) => c.type === 'INJECTED')

        if (!ids) {
          return Boolean(window.ethereum)
        }

        if (injectedConnector) {
          if (!window?.ethereum) {
            return false
          }

          return ids.some(id => Boolean(window.ethereum?.[String(id)]))
        }

        return false
      },

      disconnect: async () => {
        await disconnect(this.wagmiConfig)
        this.appKit?.setClientId(null)
        if (this.appKit?.getIsSiweEnabled()) {
          const { SIWEController } = await import('@web3modal/siwe')
          if (SIWEController.state._client?.options?.signOutOnDisconnect) {
            await SIWEController.signOut()
          }
        }
      },

      signMessage: async message => {
        const caipAddress = this.appKit?.getCaipAddress() || ''
        const account = requireCaipAddress(caipAddress)

        return signMessage(this.wagmiConfig, { message, account })
      },

      estimateGas: async args => {
        try {
          return await wagmiEstimateGas(this.wagmiConfig, {
            account: args.address,
            to: args.to,
            data: args.data,
            type: 'legacy'
          })
        } catch (error) {
          return 0n
        }
      },

      sendTransaction: async (data: SendTransactionArgs) => {
        const { chainId } = getAccount(this.wagmiConfig)

        const txParams = {
          account: data.address,
          to: data.to,
          value: data.value,
          gas: data.gas,
          gasPrice: data.gasPrice,
          data: data.data,
          chainId,
          type: 'legacy' as const
        }

        await prepareTransactionRequest(this.wagmiConfig, txParams)
        const tx = await wagmiSendTransaction(this.wagmiConfig, txParams)

        await waitForTransactionReceipt(this.wagmiConfig, { hash: tx, timeout: 25000 })

        return tx
      },

      writeContract: async (data: WriteContractArgs) => {
        const caipAddress = this.appKit?.getCaipAddress() || ''
        const account = requireCaipAddress(caipAddress)
        const chainId = NetworkUtil.caipNetworkIdToNumber(this.appKit?.getCaipNetwork()?.id)

        const tx = await wagmiWriteContract(this.wagmiConfig, {
          chainId,
          address: data.tokenAddress,
          account,
          abi: data.abi,
          functionName: data.method,
          args: [data.receiverAddress, data.tokenAmount]
        })

        return tx
      },

      getEnsAddress: async (value: string) => {
        try {
          const chainId = NetworkUtil.caipNetworkIdToNumber(this.appKit?.getCaipNetwork()?.id)
          let ensName: boolean | GetEnsAddressReturnType = false
          let wcName: boolean | string = false

          if (value?.endsWith(CommonConstants.WC_NAME_SUFFIX)) {
            wcName = (await this.appKit?.resolveWalletConnectName(value)) || false
          }

          if (chainId === mainnet.id) {
            ensName = await wagmiGetEnsAddress(this.wagmiConfig, {
              name: normalize(value),
              chainId
            })
          }

          return ensName || wcName || false
        } catch {
          return false
        }
      },

      getEnsAvatar: async (value: string) => {
        const chainId = NetworkUtil.caipNetworkIdToNumber(this.appKit?.getCaipNetwork()?.id)

        if (chainId !== mainnet.id) {
          return false
        }

        const avatar = await wagmiGetEnsAvatar(this.wagmiConfig, {
          name: normalize(value),
          chainId
        })

        return avatar || false
      },

      parseUnits,

      formatUnits
    }
  }

  public construct(appKit: AppKit, options: OptionsControllerState) {
    if (!options.projectId) {
      throw new Error('projectId is undefined')
    }

    this.appKit = appKit
    this.options = options
    this.tokens = HelpersUtil.getCaipTokens(options.tokens)

    this.syncRequestedNetworks([...this.wagmiConfig.chains])
    this.syncConnectors(this.wagmiConfig.connectors)
    this.initAuthConnectorListeners([...this.wagmiConfig.connectors])

    watchConnectors(this.wagmiConfig, {
      onChange: connectors => this.syncConnectors(connectors)
    })
    watchAccount(this.wagmiConfig, {
      onChange: accountData => this.syncAccount({ ...accountData })
    })

    this.appKit?.setEIP6963Enabled(options.enableEIP6963 !== false)
    this.appKit?.subscribeShouldUpdateToAddress((newAddress?: string) => {
      if (newAddress) {
        const connections = getConnections(this.wagmiConfig)
        const connector = connections[0]?.connector
        if (connector) {
          switchAccount(this.wagmiConfig, {
            connector
          }).then(response =>
            this.syncAccount({
              address: newAddress as Hex,
              isConnected: true,
              addresses: response.accounts,
              connector,
              chainId: response.chainId
            })
          )
        }
      }
    })
  }

  // @ts-expect-error: Overriden state type is correct
  public override subscribeState(callback: (state: Web3ModalState) => void) {
    return this.appKit?.subscribeState((state: PublicStateControllerState) =>
      callback({
        ...state,
        selectedNetworkId: NetworkUtil.caipNetworkIdToNumber(state.selectedNetworkId)
      })
    )
  }

  // -- Private -----------------------------------------------------------------
  private syncRequestedNetworks(chains: Chain[]) {
    const requestedCaipNetworks = chains?.map(
      chain =>
        ({
          id: `${ConstantsUtil.EIP155}:${chain.id}`,
          name: chain.name,
          imageId: PresetsUtil.EIP155NetworkImageIds[chain.id],
          imageUrl: this.options?.chainImages?.[chain.id],
          chain: this.chain
        }) as CaipNetwork
    )
    this.appKit?.setRequestedCaipNetworks(requestedCaipNetworks ?? [], this.chain)
  }

  private async syncAccount({
    address,
    chainId,
    connector,
    addresses,
    status
  }: Partial<
    Pick<
      GetAccountReturnType,
      | 'address'
      | 'isConnected'
      | 'isDisconnected'
      | 'chainId'
      | 'connector'
      | 'addresses'
      | 'status'
    >
  >) {
    const caipAddress: CaipAddress = `${ConstantsUtil.EIP155}:${chainId}:${address}`
    if (this.appKit?.getCaipAddress() === caipAddress) {
      return
    }

    if (status === 'connected' && address && chainId) {
      this.syncNetwork(address, chainId, true)
      this.appKit?.setIsConnected(true, this.chain)
      this.appKit?.setCaipAddress(caipAddress, this.chain)
      await Promise.all([
        this.syncProfile(address, chainId),
        this.syncBalance(address, chainId),
        this.syncConnectedWalletInfo(connector),
        this.appKit?.setApprovedCaipNetworksData(this.chain)
      ])
      if (connector) {
        this.syncConnectedWalletInfo(connector)
      }

      // Set by authConnector.onIsConnectedHandler as we need the account type
      const isAuthConnector = connector?.id === ConstantsUtil.AUTH_CONNECTOR_ID
      if (!isAuthConnector && addresses?.length) {
        this.appKit?.setAllAccounts(
          addresses.map(addr => ({ address: addr, type: 'eoa' })),
          this.chain
        )
      }
    } else if (status === 'disconnected') {
      this.appKit?.resetAccount(this.chain)
      this.appKit?.resetWcConnection()
      this.appKit?.resetNetwork()
      this.appKit?.setAllAccounts([], this.chain)
      this.appKit?.setIsConnected(false, this.chain)
    }
  }

  private async syncNetwork(address?: Hex, chainId?: number, isConnected?: boolean) {
    const chain = this.wagmiConfig.chains.find((c: Chain) => c.id === chainId)

    if (chain || chainId) {
      const name = chain?.name ?? chainId?.toString()
      const id = Number(chain?.id ?? chainId)
      const caipChainId: CaipNetworkId = `${ConstantsUtil.EIP155}:${id}`
      this.appKit?.setCaipNetwork({
        id: caipChainId,
        name,
        imageId: PresetsUtil.EIP155NetworkImageIds[id],
        imageUrl: this.options?.chainImages?.[id],
        chain: this.chain
      })
      if (isConnected && address && chainId) {
        const caipAddress: CaipAddress = `${ConstantsUtil.EIP155}:${id}:${address}`
        this.appKit?.setCaipAddress(caipAddress, this.chain)
        if (chain?.blockExplorers?.default?.url) {
          const url = `${chain.blockExplorers.default.url}/address/${address}`
          this.appKit?.setAddressExplorerUrl(url, this.chain)
        } else {
          this.appKit?.setAddressExplorerUrl(undefined, this.chain)
        }

        await this.syncBalance(address, chainId)
      }
    }
  }

  private async syncWalletConnectName(address: Hex) {
    if (!this.appKit) {
      throw new Error('syncWalletConnectName - appKit is undefined')
    }

    try {
      const registeredWcNames = await this.appKit.getWalletConnectName(address)
      if (registeredWcNames[0]) {
        const wcName = registeredWcNames[0]
        this.appKit?.setProfileName(wcName.name, this.chain)
      } else {
        this.appKit?.setProfileName(null, this.chain)
      }
    } catch {
      this.appKit?.setProfileName(null, this.chain)
    }
  }

  private async syncProfile(address: Hex, chainId: Chain['id']) {
    if (!this.appKit) {
      throw new Error('syncProfile - appKit is undefined')
    }

    try {
      const { name, avatar } = await this.appKit.fetchIdentity({
        address
      })
      this.appKit?.setProfileName(name, this.chain)
      this.appKit?.setProfileImage(avatar, this.chain)

      if (!name) {
        await this.syncWalletConnectName(address)
      }
    } catch {
      if (chainId === mainnet.id) {
        const profileName = await getEnsName(this.wagmiConfig, { address, chainId })
        if (profileName) {
          this.appKit?.setProfileName(profileName, this.chain)
          const profileImage = await wagmiGetEnsAvatar(this.wagmiConfig, {
            name: profileName,
            chainId
          })
          if (profileImage) {
            this.appKit?.setProfileImage(profileImage, this.chain)
          }
        } else {
          await this.syncWalletConnectName(address)
          this.appKit?.setProfileImage(null, this.chain)
        }
      } else {
        await this.syncWalletConnectName(address)
        this.appKit?.setProfileImage(null, this.chain)
      }
    }
  }

  private async syncBalance(address: Hex, chainId: number) {
    const chain = this.wagmiConfig.chains.find((c: Chain) => c.id === chainId)
    if (chain) {
      const balance = await getBalance(this.wagmiConfig, {
        address,
        chainId: chain.id,
        token: this.options?.tokens?.[chain.id]?.address as Hex
      })
      this.appKit?.setBalance(balance.formatted, balance.symbol, this.chain)

      return
    }
    this.appKit?.setBalance(undefined, undefined, this.chain)
  }

  private async syncConnectedWalletInfo(connector: GetAccountReturnType['connector']) {
    if (!connector) {
      throw Error('syncConnectedWalletInfo - connector is undefined')
    }

    if (connector.id === ConstantsUtil.WALLET_CONNECT_CONNECTOR_ID && connector.getProvider) {
      const walletConnectProvider = (await connector.getProvider()) as Awaited<
        ReturnType<(typeof EthereumProvider)['init']>
      >
      if (walletConnectProvider.session) {
        this.appKit?.setConnectedWalletInfo(
          {
            ...walletConnectProvider.session.peer.metadata,
            name: walletConnectProvider.session.peer.metadata.name,
            icon: walletConnectProvider.session.peer.metadata.icons?.[0]
          },
          this.chain
        )
      }
    } else {
      const wagmiConnector = this.appKit?.getConnectors().find(c => c.id === connector.id)
      this.appKit?.setConnectedWalletInfo(
        {
          name: connector.name,
          icon: connector.icon || this.appKit.getConnectorImage(wagmiConnector)
        },
        this.chain
      )
    }
  }

  private syncConnectors(connectors: AdapterOptions<Config>['wagmiConfig']['connectors']) {
    const uniqueIds = new Set()
    const filteredConnectors = connectors.filter(
      item => !uniqueIds.has(item.id) && uniqueIds.add(item.id)
    )

    const w3mConnectors: Connector[] = []

    filteredConnectors.forEach(({ id, name, type, icon }) => {
      // Auth connector is initialized separately
      const shouldSkip = ConstantsUtil.AUTH_CONNECTOR_ID === id
      if (!shouldSkip) {
        w3mConnectors.push({
          id,
          explorerId: PresetsUtil.ConnectorExplorerIds[id],
          imageUrl: this.options?.connectorImages?.[id] ?? icon,
          name: PresetsUtil.ConnectorNamesMap[id] ?? name,
          imageId: PresetsUtil.ConnectorImageIds[id],
          type: PresetsUtil.ConnectorTypesMap[type] ?? 'EXTERNAL',
          info: {
            rdns: id
          },
          chain: this.chain
        })
      }
    })
    this.appKit?.setConnectors(w3mConnectors)
    this.syncAuthConnector(filteredConnectors)
  }

  private async syncAuthConnector(connectors: AdapterOptions<Config>['wagmiConfig']['connectors']) {
    const authConnector = connectors.find(
      ({ id }) => id === ConstantsUtil.AUTH_CONNECTOR_ID
    ) as unknown as AdapterOptions<Config>['wagmiConfig']['connectors'][0] & {
      email: boolean
      socials: SocialProvider[]
      showWallets?: boolean
      walletFeatures?: boolean
    }

    if (authConnector) {
      const provider = await authConnector.getProvider()
      this.appKit?.addConnector({
        id: ConstantsUtil.AUTH_CONNECTOR_ID,
        type: 'AUTH',
        name: 'Auth',
        provider,
        email: authConnector.email,
        socials: authConnector.socials,
        showWallets: authConnector.showWallets,
        chain: this.chain,
        walletFeatures: authConnector.walletFeatures
      })
    }
  }

  private async initAuthConnectorListeners(
    connectors: AdapterOptions<Config>['wagmiConfig']['connectors']
  ) {
    const authConnector = connectors.find(({ id }) => id === ConstantsUtil.AUTH_CONNECTOR_ID)
    if (authConnector) {
      await this.listenAuthConnector(authConnector)
      await this.listenModal(authConnector)
    }
  }

  private async listenAuthConnector(
    connector: AdapterOptions<Config>['wagmiConfig']['connectors'][number]
  ) {
    if (typeof window !== 'undefined' && connector) {
      this.appKit?.setLoading(true)
      const provider = (await connector.getProvider()) as W3mFrameProvider
      const isLoginEmailUsed = provider.getLoginEmailUsed()

      this.appKit?.setLoading(isLoginEmailUsed)

      if (isLoginEmailUsed) {
        this.appKit?.setIsConnected(false, this.chain)
      }

      provider.onRpcRequest((request: W3mFrameTypes.RPCRequest) => {
        if (W3mFrameHelpers.checkIfRequestExists(request)) {
          if (!W3mFrameHelpers.checkIfRequestIsSafe(request)) {
            this.appKit?.handleUnsafeRPCRequest()
          }
        } else {
          this.appKit?.open()
          // eslint-disable-next-line no-console
          console.error(W3mFrameRpcConstants.RPC_METHOD_NOT_ALLOWED_MESSAGE, {
            method: request.method
          })
          setTimeout(() => {
            this.appKit?.showErrorMessage(W3mFrameRpcConstants.RPC_METHOD_NOT_ALLOWED_UI_MESSAGE)
          }, 300)
          provider.rejectRpcRequests()
        }
      })

      provider.onRpcError(() => {
        const isModalOpen = this.appKit?.isOpen()

        if (isModalOpen) {
          if (this.appKit?.isTransactionStackEmpty()) {
            this.appKit?.close()
          } else {
            this.appKit?.popTransactionStack(true)
          }
        }
      })

      provider.onRpcSuccess((_, request) => {
        const isSafeRequest = W3mFrameHelpers.checkIfRequestIsSafe(request)
        if (isSafeRequest) {
          return
        }

        if (this.appKit?.isTransactionStackEmpty()) {
          this.appKit?.close()
        } else {
          this.appKit?.popTransactionStack()
        }
      })

      provider.onNotConnected(() => {
        const isConnected = this.appKit?.getIsConnectedState()
        if (!isConnected) {
          this.appKit?.setIsConnected(false, this.chain)
          this.appKit?.setLoading(false)
        }
      })

      provider.onIsConnected(req => {
        this.appKit?.setIsConnected(true, this.chain)
        this.appKit?.setSmartAccountDeployed(Boolean(req.smartAccountDeployed), this.chain)
        this.appKit?.setPreferredAccountType(
          req.preferredAccountType as W3mFrameTypes.AccountType,
          this.chain
        )
        this.appKit?.setLoading(false)
        this.appKit?.setAllAccounts(
          req.accounts || [
            {
              address: req.address,
              type: (req.preferredAccountType || 'eoa') as W3mFrameTypes.AccountType
            }
          ],
          this.chain
        )
      })

      provider.onGetSmartAccountEnabledNetworks(networks => {
        this.appKit?.setSmartAccountEnabledNetworks(networks, this.chain)
      })

      provider.onSetPreferredAccount(({ address, type }) => {
        if (!address) {
          return
        }
        this.appKit?.setPreferredAccountType(type as W3mFrameTypes.AccountType, this.chain)
        reconnect(this.wagmiConfig, { connectors: [connector] })
      })
    }
  }

  private async listenModal(
    connector: AdapterOptions<Config>['wagmiConfig']['connectors'][number]
  ) {
    const provider = (await connector.getProvider()) as W3mFrameProvider
    this.subscribeState(val => {
      if (!val.open) {
        provider.rejectRpcRequests()
      }
    })
  }
}
