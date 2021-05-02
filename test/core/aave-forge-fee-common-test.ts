import { expect } from "chai";
import { createFixtureLoader } from "ethereum-waffle";
import { BigNumber as BN, Contract, Wallet } from "ethers";
import {
  advanceTime,
  amountToWei,
  approxBigNumber,
  consts,
  errMsg,
  evm_revert,
  evm_snapshot,
  getA2Contract,
  getAContract,
  mintAaveToken,
  setTimeNextBlock,
  setTime,
  Token,
  tokens,
  emptyToken,
  randomBN,
} from "../helpers";
import { pendleFixture, PendleFixture } from "./fixtures";

const { waffle } = require("hardhat");
const provider = waffle.provider;

interface TestEnv {
  T0: BN;
  FORGE_ID: string;
  INITIAL_AAVE_TOKEN_AMOUNT: BN;
  TEST_DELTA: BN;
}

export function runTest(isAaveV1: boolean) {
  describe("", async () => {
    const wallets = provider.getWallets();
    const loadFixture = createFixtureLoader(wallets, provider);
    const [alice, bob, charlie, dave] = wallets;
    const forgeFee = randomBN(consts.RONE.toNumber() / 10);

    let fixture: PendleFixture;
    let router: Contract;
    let routerWeb3: any;
    let ot: Contract;
    let xyt: Contract;
    let aaveForge: Contract;
    let aUSDT: Contract;
    let snapshotId: string;
    let globalSnapshotId: string;
    let tokenUSDT: Token;
    let refAmount: BN;
    let initialAUSDTbalance: BN;
    let testEnv: TestEnv = {} as TestEnv;
    let data: Contract;

    async function buildCommonTestEnv() {
      fixture = await loadFixture(pendleFixture);
      router = fixture.core.router;
      routerWeb3 = fixture.core.routerWeb3;
      tokenUSDT = tokens.USDT;
      data = fixture.core.data;
      testEnv.INITIAL_AAVE_TOKEN_AMOUNT = consts.INITIAL_AAVE_TOKEN_AMOUNT;
      testEnv.TEST_DELTA = BN.from(10000);
    }

    async function buildTestEnvV1() {
      ot = fixture.aForge.aOwnershipToken;
      xyt = fixture.aForge.aFutureYieldToken;
      aaveForge = fixture.aForge.aaveForge;
      aUSDT = await getAContract(alice, aaveForge, tokenUSDT);
      testEnv.FORGE_ID = consts.FORGE_AAVE;
      testEnv.T0 = consts.T0;
    }

    async function buildTestEnvV2() {
      ot = fixture.a2Forge.a2OwnershipToken;
      xyt = fixture.a2Forge.a2FutureYieldToken;
      aaveForge = fixture.a2Forge.aaveV2Forge;
      aUSDT = await getA2Contract(alice, aaveForge, tokenUSDT);
      testEnv.FORGE_ID = consts.FORGE_AAVE_V2;
      testEnv.T0 = consts.T0_A2;
    }

    before(async () => {
      globalSnapshotId = await evm_snapshot();
      await buildCommonTestEnv();
      if (isAaveV1) {
        await buildTestEnvV1();
      } else {
        await buildTestEnvV2();
      }
      await data.setForgeFee(forgeFee);

      snapshotId = await evm_snapshot();
    });

    after(async () => {
      await evm_revert(globalSnapshotId);
    });

    beforeEach(async () => {
      await evm_revert(snapshotId);
      snapshotId = await evm_snapshot();
      refAmount = amountToWei(testEnv.INITIAL_AAVE_TOKEN_AMOUNT, 6);
      await startCalInterest(alice, refAmount.mul(10)); // mint a large amount of aTokens for testing;
      initialAUSDTbalance = await aUSDT.balanceOf(alice.address);
    });

    async function tokenizeYield(user: Wallet, amount: BN): Promise<BN> {
      let amountTokenMinted = await ot.balanceOf(user.address);
      await router.tokenizeYield(
        testEnv.FORGE_ID,
        tokenUSDT.address,
        testEnv.T0.add(consts.SIX_MONTH),
        amount,
        user.address,
        consts.HIGH_GAS_OVERRIDE
      );
      amountTokenMinted = (await ot.balanceOf(user.address)).sub(
        amountTokenMinted
      );
      return amountTokenMinted;
    }

    async function redeemDueInterests(user: Wallet, expiry: BN) {
      await router
        .connect(user)
        .redeemDueInterests(testEnv.FORGE_ID, tokenUSDT.address, expiry);
    }

    async function startCalInterest(walletToUse: Wallet, initialAmount: BN) {
      // divide by 10^decimal since mintAaveToken will multiply that number back
      await mintAaveToken(
        provider,
        tokenUSDT,
        walletToUse,
        initialAmount.div(10 ** tokenUSDT.decimal),
        isAaveV1
      );
    }

    async function getCurInterest(
      walletToUse: Wallet,
      initialAmount: BN
    ): Promise<BN> {
      return (await aUSDT.balanceOf(walletToUse.address)).sub(initialAmount);
    }

    // Bob has refAmount of XYTs
    // Charlie has equivalent amount of aUSDT
    // When bob redeem due interests, Bob should get the interest gotten by Charlie - fee portion
    it("User should get back interest minus protocol fees", async () => {
      await aUSDT.transfer(charlie.address, refAmount);
      await tokenizeYield(bob, refAmount);

      await setTimeNextBlock(provider, testEnv.T0.add(consts.ONE_MONTH));
      await redeemDueInterests(bob, testEnv.T0.add(consts.SIX_MONTH));
      const bobInterest = await aUSDT.balanceOf(bob.address);
      const charlieInterest = (await aUSDT.balanceOf(charlie.address)).sub(
        refAmount
      );
      approxBigNumber(
        charlieInterest.mul(consts.RONE.sub(forgeFee)).div(consts.RONE),
        bobInterest,
        BN.from(150)
      );

      const accruedProtocolFee = await aaveForge.accruedProtocolFee(
        tokenUSDT.address
      );
      approxBigNumber(
        charlieInterest.sub(bobInterest),
        accruedProtocolFee,
        BN.from(150)
      );
    });

    it("Governance address should be able to withdraw protocol fees", async () => {
      await tokenizeYield(bob, refAmount);

      await setTimeNextBlock(provider, testEnv.T0.add(consts.ONE_MONTH));
      await redeemDueInterests(bob, testEnv.T0.add(consts.SIX_MONTH));

      const accruedProtocolFee = await aaveForge.accruedProtocolFee(
        tokenUSDT.address
      );
      await aaveForge.withdrawProtocolFee(tokenUSDT.address);
      const treasuryAddress = await data.treasury();
      const treasuryBalance = await aUSDT.balanceOf(treasuryAddress);
      approxBigNumber(accruedProtocolFee, treasuryBalance, BN.from(5));
      const protocolFeeLeft = await aaveForge.accruedProtocolFee(
        tokenUSDT.address
      );
      approxBigNumber(protocolFeeLeft, BN.from(0), BN.from(5));
    });
    it("Non-governance address should not be able to withdraw protocol fees", async () => {
      await tokenizeYield(bob, refAmount);

      await setTimeNextBlock(provider, testEnv.T0.add(consts.ONE_MONTH));
      await redeemDueInterests(bob, testEnv.T0.add(consts.SIX_MONTH));

      await expect(
        aaveForge.connect(bob).withdrawProtocolFee(tokenUSDT.address)
      ).to.be.revertedWith(errMsg.ONLY_GOVERNANCE);
    });
  });
}
