/**
 * GeoASN lookup service using MaxMind GeoLite2 ASN database
 */

import maxmind, { type AsnResponse, type Reader } from 'maxmind';
import { geoipService } from './geoip.js';

export interface GeoASN {
  number: number | null;
  organization: string | null;
}

const NULL_ASN: GeoASN = {
  number: null,
  organization: null,
};

export class GeoASNService {
  private reader: Reader<AsnResponse> | null = null;
  private initialized = false;

  async initialize(dbPath: string): Promise<void> {
    try {
      this.reader = await maxmind.open<AsnResponse>(dbPath);
      this.initialized = true;
    } catch (error) {
      console.warn(
        `GeoASN database not loaded: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
      this.reader = null;
      this.initialized = true;
    }
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  hasDatabase(): boolean {
    return this.reader !== null;
  }

  lookup(ip: string): GeoASN {
    if (geoipService.isPrivateIP(ip)) {
      return NULL_ASN;
    }

    if (!this.reader) {
      return NULL_ASN;
    }

    try {
      const result = this.reader.get(ip);

      if (!result) {
        return NULL_ASN;
      }

      return {
        number: result.autonomous_system_number ?? null,
        organization: result.autonomous_system_organization ?? null,
      };
    } catch {
      return NULL_ASN;
    }
  }
}

export const geoasnService = new GeoASNService();
