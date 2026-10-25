import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";

const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOCIATED_TOKEN_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

/** The owner's associated token account of `mint`: one address on Solana and in the rollup. */
export const associatedTokenAddress = (owner: PublicKey, mint: PublicKey): PublicKey =>
  PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM,
  )[0];

/** Creates the associated token account unless it exists (the token program's idempotent create). */
export const createAssociatedTokenAccountIdempotentIx = (
  payer: PublicKey,
  account: PublicKey,
  owner: PublicKey,
  mint: PublicKey,
): TransactionInstruction =>
  new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: account, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]),
  });
