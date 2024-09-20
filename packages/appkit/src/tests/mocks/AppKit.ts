import { vi } from 'vitest'
import type { AppKit } from '../../client.js'
import { mainnet } from '../../networks/index.js'

// Mock values
let isConnected = false
let caipAddress: string | undefined = undefined

export const mockAppKit = {
  setIsConnected: vi.fn((_isConnected: boolean) => {
    isConnected = _isConnected
  }),
  getIsConnectedState: vi.fn(() => isConnected),
  getCaipAddress: vi.fn(() => caipAddress),
  setCaipAddress: vi.fn((_caipAddress: string) => {
    caipAddress = _caipAddress
  }),
  setRequestedCaipNetworks: vi.fn(),
  setConnectors: vi.fn(),
  getConnectors: vi.fn().mockReturnValue([]),
  getActiveChainNamespace: vi.fn(),
  setConnectedWalletInfo: vi.fn(),
  resetWcConnection: vi.fn(),
  resetNetwork: vi.fn(),
  resetAccount: vi.fn(),
  setAllAccounts: vi.fn(),
  setPreferredAccountType: vi.fn(),
  getPreferredAccountType: vi.fn().mockReturnValue('eoa'),
  getCaipNetwork: vi.fn().mockReturnValue(mainnet),
  setApprovedCaipNetworksData: vi.fn(),
  getAddress: vi.fn().mockReturnValue('0xE62a3eD41B21447b67a63880607CD2E746A0E35d')
} as unknown as AppKit

export default mockAppKit
