import { IsString, Matches } from 'class-validator';
import { PUBLIC_KEY_HEX_REGEX, PUBLIC_KEY_HEX_MESSAGE } from './deploy-wallet.dto';

/** Query DTO for `GET /wallets/resolve` — same format rules as deploy. */
export class ResolveWalletQueryDto {
  @IsString()
  @Matches(PUBLIC_KEY_HEX_REGEX, {
    message: PUBLIC_KEY_HEX_MESSAGE,
  })
  publicKeyHex!: string;
}
