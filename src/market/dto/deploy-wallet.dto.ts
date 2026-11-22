import { IsString, Matches } from 'class-validator';

/** Shared format: 65-byte uncompressed secp256r1 SEC1 public key, hex-encoded (130 hex chars). */
export const PUBLIC_KEY_HEX_REGEX = /^04[0-9a-fA-F]{128}$/;
export const PUBLIC_KEY_HEX_MESSAGE =
  'publicKeyHex must be a 65-byte (130 hex char) uncompressed SEC1 point starting with 04';

export class DeployWalletDto {
  /** 65-byte uncompressed secp256r1 SEC1 public key, hex-encoded (130 hex chars). */
  @IsString()
  @Matches(PUBLIC_KEY_HEX_REGEX, {
    message: PUBLIC_KEY_HEX_MESSAGE,
  })
  publicKeyHex!: string;
}
