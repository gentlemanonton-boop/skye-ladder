import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { SkyeLadder } from "../target/types/skye_ladder";
import { expect } from "chai";

describe("skye-ladder", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.SkyeLadder as Program<SkyeLadder>;

  it("Initializes the transfer hook config", async () => {
    // TODO: Step 2+ — create Token-2022 mint with transfer hook extension,
    // call initialize, and verify Config + ExtraAccountMetaList PDAs.
  });
});
