import type { Account, Device } from '../../shared/api-contracts.js';

declare global {
  namespace Express {
    interface Request {
      baiaAccount?: Account;
      baiaAccountSession?: { authenticatedAt?: number; authVersion?: number } | null;
      baiaDevice?: Device;
      baiaLocalAccess?: boolean;
    }
  }
}

export {};
