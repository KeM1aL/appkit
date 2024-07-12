/* eslint-disable no-console */
import { formatMessage } from '@walletconnect/utils'
import { ConstantsUtil } from '@web3modal/common'
import { ApiController } from '@web3modal/core'
import { Web3ModalSIWEClient } from '../../src/client.js'
import type { SIWECreateMessageArgs, SIWESession, SIWEVerifyMessageArgs } from './TypeUtils.js'

export async function getNonce() {
  try {
    const res = await fetch(`${ConstantsUtil.W3M_API_URL}/auth/v1/nonce`, {
      method: 'GET',
      headers: ApiController._getApiHeaders(),
      credentials: 'include'
    })

    if (!res.ok) {
      return undefined
    }

    const nonceRes = await res.json()

    return nonceRes
  } catch (error) {
    console.error(error)
    throw new Error('Failed to get nonce', {
      cause: error
    })
  }
}

export async function getAppKitAuthSession() {
  try {
    const res = await fetch(`${ConstantsUtil.W3M_API_URL}/auth/v1/me`, {
      method: 'GET',
      headers: ApiController._getApiHeaders(),
      credentials: 'include'
    })

    if (!res.ok) {
      return undefined
    }

    const sessionRes = await res.json()

    return sessionRes
  } catch (error) {
    console.error(error)
    throw new Error('Failed to get session', {
      cause: error
    })
  }
}

export async function authenticate(payload: {
  message: string
  signature: string
  clientId?: string
}) {
  try {
    const res = await fetch(`${ConstantsUtil.W3M_API_URL}/auth/v1/authenticate`, {
      method: 'POST',
      headers: ApiController._getApiHeaders(),
      body: JSON.stringify(payload),
      credentials: 'include'
    })

    if (!res.ok) {
      return undefined
    }

    const authenticateRes = await res.json()

    return authenticateRes
  } catch (error) {
    console.error(error)
    throw new Error('Failed to authenticate', {
      cause: error
    })
  }
}

export async function updateUser(metadata: Record<string, unknown>) {
  try {
    const res = await fetch(`${ConstantsUtil.W3M_API_URL}/auth/v1/update-user`, {
      method: 'POST',
      headers: ApiController._getApiHeaders(),
      body: JSON.stringify({ metadata }),
      credentials: 'include'
    })

    if (!res.ok) {
      return undefined
    }

    const updateUserRes = await res.json()

    return updateUserRes
  } catch (error) {
    console.error(error)
    throw new Error('Failed to authenticate', {
      cause: error
    })
  }
}

export async function appKitAuthSignOut() {
  try {
    const res = await fetch(`${ConstantsUtil.W3M_API_URL}/auth/v1/sign-out`, {
      method: 'POST',
      headers: ApiController._getApiHeaders(),
      credentials: 'include'
    })

    const signOutRes = await res.json()

    return signOutRes
  } catch (error) {
    console.error(error)
    throw new Error('Failed to sign out', {
      cause: error
    })
  }
}

export const appKitAuthConfig = new Web3ModalSIWEClient({
  signOutOnAccountChange: true,
  signOutOnNetworkChange: true,
  // We don't require any async action to populate params but other apps might
  // eslint-disable-next-line @typescript-eslint/require-await
  getMessageParams: async () => ({
    domain: window.location.host,
    uri: window.location.origin,
    statement: 'Please sign with your account',
    iat: new Date().toISOString()
  }),
  createMessage: ({ address, ...args }: SIWECreateMessageArgs) => {
    const message = formatMessage(args, address)

    return message
  },
  getNonce: async () => {
    const { nonce } = await getNonce()
    if (!nonce) {
      throw new Error('Failed to get nonce!')
    }

    return nonce
  },
  getSession: async () => {
    const session = await getAppKitAuthSession()
    if (!session) {
      return null
    }

    const { address, chainId } = session as unknown as SIWESession

    return { address, chainId }
  },
  verifyMessage: async ({ message, signature, cacao, clientId }: SIWEVerifyMessageArgs) => {
    try {
      /*
       * Signed Cacao (CAIP-74) will be available for further validations if the wallet supports caip-222 signing
       * When personal_sign fallback is used, cacao will be undefined
       */
      if (cacao) {
        // Do something
      }
      const { token } = await authenticate({ message, signature, clientId })

      return Boolean(token)
    } catch (error) {
      return false
    }
  },
  signOut: async () => {
    try {
      await appKitAuthSignOut()

      return true
    } catch (error) {
      return false
    }
  }
})
