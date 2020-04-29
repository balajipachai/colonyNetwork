/* globals artifacts */

import BN from "bn.js";
import chai from "chai";
import bnChai from "bn-chai";

import { UINT256_MAX, WAD, MINING_CYCLE_DURATION, DEFAULT_STAKE, SECONDS_PER_DAY, SUBMITTER_ONLY_WINDOW } from "../../helpers/constants";
import { checkErrorRevert, makeReputationKey, makeReputationValue, getActiveRepCycle, forwardTime, getBlockTime } from "../../helpers/test-helper";

import {
  setupColonyNetwork,
  setupMetaColonyWithLockedCLNYToken,
  setupRandomColony,
  giveUserCLNYTokensAndStake,
} from "../../helpers/test-data-generator";

import PatriciaTree from "../../packages/reputation-miner/patricia";

const { expect } = chai;
chai.use(bnChai(web3.utils.BN));

const TokenLocking = artifacts.require("TokenLocking");
const FundingQueue = artifacts.require("FundingQueue");
const FundingQueueFactory = artifacts.require("FundingQueueFactory");

contract("Funding Queues", (accounts) => {
  let colony;
  let token;
  let domain1;
  let metaColony;
  let colonyNetwork;
  let tokenLocking;

  let fundingQueue;
  let fundingQueueFactory;

  let reputationTree;

  let colonyKey;
  let colonyValue;
  let colonyMask;
  let colonySiblings;

  let user0Key;
  let user0Value;
  let user0Mask;
  let user0Siblings;

  let user1Key;
  let user1Value;
  let user1Mask;
  let user1Siblings;

  const USER0 = accounts[0];
  const USER1 = accounts[1];
  const MINER = accounts[5];

  const HEAD = 0;

  const STATE_INACTIVE = 0;
  const STATE_ACTIVE = 1;
  const STATE_COMPLETED = 2;
  const STATE_CANCELLED = 3;

  before(async () => {
    colonyNetwork = await setupColonyNetwork();
    ({ metaColony } = await setupMetaColonyWithLockedCLNYToken(colonyNetwork));
    await giveUserCLNYTokensAndStake(colonyNetwork, MINER, DEFAULT_STAKE);
    await colonyNetwork.initialiseReputationMining();
    await colonyNetwork.startNextCycle();

    fundingQueueFactory = await FundingQueueFactory.new();

    const tokenLockingAddress = await colonyNetwork.getTokenLocking();
    tokenLocking = await TokenLocking.at(tokenLockingAddress);
  });

  beforeEach(async () => {
    ({ colony, token } = await setupRandomColony(colonyNetwork));

    // 1 => { 2, 3 }
    await colony.addDomain(1, UINT256_MAX, 1);
    await colony.addDomain(1, UINT256_MAX, 1);
    domain1 = await colony.getDomain(1);

    await fundingQueueFactory.deployExtension(colony.address);
    const fundingQueueAddress = await fundingQueueFactory.deployedExtensions(colony.address);
    fundingQueue = await FundingQueue.at(fundingQueueAddress);
    await colony.setFundingRole(1, UINT256_MAX, fundingQueue.address, 1, true);

    await token.mint(colony.address, WAD);
    await colony.claimColonyFunds(token.address);

    await token.mint(USER0, WAD);
    await token.approve(tokenLocking.address, WAD, { from: USER0 });
    await tokenLocking.deposit(token.address, WAD, { from: USER0 });
    await colony.approveStake(fundingQueue.address, 1, WAD, { from: USER0 });

    reputationTree = new PatriciaTree();
    await reputationTree.insert(
      makeReputationKey(colony.address, domain1.skillId), // Colony total, domain 1
      makeReputationValue(WAD.muln(3), 1)
    );
    await reputationTree.insert(
      makeReputationKey(colony.address, domain1.skillId, USER0), // User0
      makeReputationValue(WAD, 2)
    );
    await reputationTree.insert(
      makeReputationKey(metaColony.address, domain1.skillId, USER0), // Wrong colony
      makeReputationValue(WAD, 3)
    );
    await reputationTree.insert(
      makeReputationKey(colony.address, 1234, USER0), // Wrong skill
      makeReputationValue(WAD, 4)
    );
    await reputationTree.insert(
      makeReputationKey(colony.address, domain1.skillId, USER1), // User1 (and 2x value)
      makeReputationValue(WAD.muln(2), 5)
    );

    colonyKey = makeReputationKey(colony.address, domain1.skillId);
    colonyValue = makeReputationValue(WAD.muln(3), 1);
    [colonyMask, colonySiblings] = await reputationTree.getProof(colonyKey);

    user0Key = makeReputationKey(colony.address, domain1.skillId, USER0);
    user0Value = makeReputationValue(WAD, 2);
    [user0Mask, user0Siblings] = await reputationTree.getProof(user0Key);

    user1Key = makeReputationKey(colony.address, domain1.skillId, USER1);
    user1Value = makeReputationValue(WAD.muln(2), 5);
    [user1Mask, user1Siblings] = await reputationTree.getProof(user1Key);

    const rootHash = await reputationTree.getRootHash();
    const repCycle = await getActiveRepCycle(colonyNetwork);
    await forwardTime(MINING_CYCLE_DURATION + SUBMITTER_ONLY_WINDOW, this);
    await repCycle.submitRootHash(rootHash, 0, "0x00", 10, { from: MINER });
    await repCycle.confirmNewHash(0);
  });

  describe("using the extension factory", async () => {
    it("can install the extension factory once if root and uninstall", async () => {
      ({ colony } = await setupRandomColony(colonyNetwork));
      await checkErrorRevert(fundingQueueFactory.deployExtension(colony.address, { from: USER1 }), "colony-extension-user-not-root");
      await fundingQueueFactory.deployExtension(colony.address, { from: USER0 });
      await checkErrorRevert(fundingQueueFactory.deployExtension(colony.address, { from: USER0 }), "colony-extension-already-deployed");
      await fundingQueueFactory.removeExtension(colony.address, { from: USER0 });
    });
  });

  describe("creating funding proposals", async () => {
    it("can create a basic proposal", async () => {
      await fundingQueue.createProposal(1, UINT256_MAX, 0, 1, 2, WAD, token.address, { from: USER0 });
      const proposalId = await fundingQueue.getProposalCount();

      const proposal = await fundingQueue.getProposal(proposalId);
      expect(proposal.domainId).to.eq.BN(1);
      expect(proposal.state).to.eq.BN(STATE_INACTIVE);
    });

    it("cannot create a basic proposal with bad inheritence", async () => {
      await checkErrorRevert(fundingQueue.createProposal(1, 0, 1, 1, 3, WAD, token.address, { from: USER0 }), "funding-queue-bad-inheritence-from");
      await checkErrorRevert(fundingQueue.createProposal(1, 1, 0, 3, 1, WAD, token.address, { from: USER0 }), "funding-queue-bad-inheritence-to");
    });

    it("can stake a proposal", async () => {
      await fundingQueue.createProposal(1, UINT256_MAX, 0, 1, 2, WAD, token.address, { from: USER0 });
      const proposalId = await fundingQueue.getProposalCount();

      await checkErrorRevert(
        fundingQueue.stakeProposal(proposalId, colonyKey, colonyValue, colonyMask, colonySiblings, { from: USER1 }),
        "funding-queue-not-creator"
      );

      await fundingQueue.stakeProposal(proposalId, colonyKey, colonyValue, colonyMask, colonySiblings, { from: USER0 });

      const proposal = await fundingQueue.getProposal(proposalId);
      expect(proposal.domainTotalRep).to.eq.BN(WAD.muln(3));
      expect(proposal.state).to.eq.BN(STATE_ACTIVE);

      // But can't stake twice
      await checkErrorRevert(
        fundingQueue.stakeProposal(proposalId, colonyKey, colonyValue, colonyMask, colonySiblings, { from: USER0 }),
        "funding-queue-not-inactive"
      );
    });

    it("can cancel a proposal, if creator", async () => {
      await fundingQueue.createProposal(1, UINT256_MAX, 0, 1, 2, WAD, token.address, { from: USER0 });
      const proposalId = await fundingQueue.getProposalCount();

      await checkErrorRevert(fundingQueue.cancelProposal(proposalId, proposalId, { from: USER1 }), "funding-queue-not-creator");
      await checkErrorRevert(fundingQueue.cancelProposal(proposalId, HEAD, { from: USER0 }), "funding-queue-bad-prev-id");

      await fundingQueue.cancelProposal(proposalId, proposalId, { from: USER0 });

      const proposal = await fundingQueue.getProposal(proposalId);
      expect(proposal.state).to.eq.BN(STATE_CANCELLED);

      const nextId = await fundingQueue.getNextProposalId(proposalId);
      expect(nextId).to.be.zero;

      // But can't cancel twice
      await checkErrorRevert(fundingQueue.cancelProposal(proposalId, proposalId, { from: USER0 }), "funding-queue-already-cancelled");
    });

    it("can cancel a proposal and reclaim stake after ten days", async () => {
      await fundingQueue.createProposal(1, UINT256_MAX, 0, 1, 2, WAD, token.address, { from: USER0 });
      const proposalId = await fundingQueue.getProposalCount();

      await fundingQueue.stakeProposal(proposalId, colonyKey, colonyValue, colonyMask, colonySiblings, { from: USER0 });

      const proposal = await fundingQueue.getProposal(proposalId);
      expect(proposal.state).to.eq.BN(STATE_ACTIVE);

      const obligationPre = await tokenLocking.getTotalObligation(USER0, token.address);
      expect(obligationPre).to.eq.BN(WAD.muln(3).divn(1000));

      await fundingQueue.cancelProposal(proposalId, proposalId, { from: USER0 });

      // Can cancel & reclaim stake after 10 days
      await checkErrorRevert(fundingQueue.reclaimStake(proposalId), "funding-queue-cooldown-not-elapsed");

      await forwardTime(SECONDS_PER_DAY * 14, this);
      await fundingQueue.reclaimStake(proposalId);

      const obligationPost = await tokenLocking.getTotalObligation(USER0, token.address);
      expect(obligationPost).to.be.zero;
    });

    it("cannot reclaim a stake for an active proposal", async () => {
      await fundingQueue.createProposal(1, UINT256_MAX, 0, 1, 2, WAD, token.address, { from: USER0 });
      const proposalId = await fundingQueue.getProposalCount();

      await fundingQueue.stakeProposal(proposalId, colonyKey, colonyValue, colonyMask, colonySiblings, { from: USER0 });

      await checkErrorRevert(fundingQueue.reclaimStake(proposalId), "funding-queue-proposal-still-active");
    });
  });

  describe("backing funding proposals", async () => {
    let proposalId;

    beforeEach(async () => {
      await fundingQueue.createProposal(1, UINT256_MAX, 0, 1, 2, WAD, token.address, { from: USER0 });
      proposalId = await fundingQueue.getProposalCount();

      await fundingQueue.stakeProposal(proposalId, colonyKey, colonyValue, colonyMask, colonySiblings, { from: USER0 });
    });

    it("can back a basic proposal", async () => {
      await fundingQueue.backProposal(proposalId, WAD, proposalId, HEAD, user0Key, user0Value, user0Mask, user0Siblings, { from: USER0 });

      const headId = await fundingQueue.getNextProposalId(HEAD);
      expect(headId).to.eq.BN(proposalId);

      const support = await fundingQueue.getSupport(proposalId, USER0);
      expect(support).to.eq.BN(WAD);
    });

    it("can back a basic proposal twice, with no effect", async () => {
      await fundingQueue.backProposal(proposalId, WAD, proposalId, HEAD, user0Key, user0Value, user0Mask, user0Siblings, { from: USER0 });
      await fundingQueue.backProposal(proposalId, WAD, HEAD, HEAD, user0Key, user0Value, user0Mask, user0Siblings, { from: USER0 });

      const headId = await fundingQueue.getNextProposalId(HEAD);
      expect(headId).to.eq.BN(proposalId);

      const support = await fundingQueue.getSupport(proposalId, USER0);
      expect(support).to.eq.BN(WAD);
    });

    it("cannot back a basic proposal with more than your reputation", async () => {
      await checkErrorRevert(
        fundingQueue.backProposal(proposalId, WAD.addn(1), proposalId, HEAD, user0Key, user0Value, user0Mask, user0Siblings, { from: USER0 }),
        "funding-queue-insufficient-reputation"
      );
    });

    it("cannot back a basic proposal with a bad reputation proof", async () => {
      await checkErrorRevert(
        fundingQueue.backProposal(proposalId, WAD, proposalId, HEAD, "0x0", "0x0", "0x0", [], { from: USER0 }),
        "funding-queue-invalid-root-hash"
      );
    });

    it("cannot back a basic proposal with the wrong user address", async () => {
      await checkErrorRevert(
        fundingQueue.backProposal(proposalId, WAD, proposalId, HEAD, user0Key, user0Value, user0Mask, user0Siblings, { from: USER1 }),
        "funding-queue-invalid-user-address"
      );
    });

    it("cannot back a basic proposal with the wrong domain skill id", async () => {
      const key = makeReputationKey(colony.address, 1234, USER0);
      const value = makeReputationValue(WAD, 4);
      const [mask, siblings] = await reputationTree.getProof(key);

      await checkErrorRevert(
        fundingQueue.backProposal(proposalId, WAD, proposalId, HEAD, key, value, mask, siblings, { from: USER0 }),
        "funding-queue-invalid-skill-id"
      );
    });

    it("cannot back a basic proposal with the wrong colony address", async () => {
      const key = makeReputationKey(metaColony.address, domain1.skillId, USER0);
      const value = makeReputationValue(WAD, 3);
      const [mask, siblings] = await reputationTree.getProof(key);

      await checkErrorRevert(
        fundingQueue.backProposal(proposalId, WAD, proposalId, HEAD, key, value, mask, siblings, { from: USER0 }),
        "funding-queue-invalid-colony-address"
      );
    });

    it("cannot back a nonexistent basic proposal", async () => {
      await checkErrorRevert(
        fundingQueue.backProposal(0, WAD, 0, HEAD, user0Key, user0Value, user0Mask, user0Siblings, { from: USER0 }),
        "funding-queue-proposal-not-active"
      );
    });

    it("cannot put a basic proposal after itself", async () => {
      await checkErrorRevert(
        fundingQueue.backProposal(proposalId, WAD, proposalId, proposalId, user0Key, user0Value, user0Mask, user0Siblings, { from: USER0 }),
        "funding-queue-cannot-insert-after-self"
      );
    });

    it("cannot put a basic proposal after a nonexistent proposal", async () => {
      await checkErrorRevert(
        fundingQueue.backProposal(proposalId, WAD, proposalId, 10, user0Key, user0Value, user0Mask, user0Siblings, { from: USER0 }),
        "funding-queue-excess-support"
      );
    });

    it("cannot pass a false current location", async () => {
      await checkErrorRevert(
        fundingQueue.backProposal(proposalId, WAD, 10, HEAD, user0Key, user0Value, user0Mask, user0Siblings, { from: USER0 }),
        "funding-queue-bad-prev-id"
      );
    });

    it("cannot put a basic proposal before a more popular proposal", async () => {
      await fundingQueue.createProposal(1, UINT256_MAX, 0, 1, 2, WAD, token.address, { from: USER0 });
      const proposal2Id = await fundingQueue.getProposalCount();
      await fundingQueue.stakeProposal(proposal2Id, colonyKey, colonyValue, colonyMask, colonySiblings, { from: USER0 });

      await fundingQueue.createProposal(1, UINT256_MAX, 0, 1, 2, WAD, token.address, { from: USER0 });
      const proposal3Id = await fundingQueue.getProposalCount();
      await fundingQueue.stakeProposal(proposal3Id, colonyKey, colonyValue, colonyMask, colonySiblings, { from: USER0 });

      // Put proposal2 in position 1 (3 wad support) and proposal3 in position 2 (2 wad support)
      await fundingQueue.backProposal(proposal2Id, WAD, proposal2Id, HEAD, user0Key, user0Value, user0Mask, user0Siblings, { from: USER0 });
      await fundingQueue.backProposal(proposal2Id, WAD.muln(2), HEAD, HEAD, user1Key, user1Value, user1Mask, user1Siblings, { from: USER1 });
      await fundingQueue.backProposal(proposal3Id, WAD.muln(2), proposal3Id, proposal2Id, user1Key, user1Value, user1Mask, user1Siblings, {
        from: USER1,
      });

      // Can't put proposal in position 1
      await checkErrorRevert(
        fundingQueue.backProposal(proposalId, WAD, proposalId, HEAD, user0Key, user0Value, user0Mask, user0Siblings, { from: USER0 }),
        "funding-queue-insufficient-support"
      );

      // Can't put proposal in position 2
      await checkErrorRevert(
        fundingQueue.backProposal(proposalId, WAD, proposalId, proposal2Id, user0Key, user0Value, user0Mask, user0Siblings, { from: USER0 }),
        "funding-queue-insufficient-support"
      );

      // But can in position 3 (1 wad support)
      await fundingQueue.backProposal(proposalId, WAD, proposalId, proposal3Id, user0Key, user0Value, user0Mask, user0Siblings, { from: USER0 });

      const nextProposalId = await fundingQueue.getNextProposalId(proposal3Id);
      expect(nextProposalId).to.eq.BN(proposalId);
    });

    it("cannot put a basic proposal after a less popular proposal", async () => {
      await fundingQueue.createProposal(1, UINT256_MAX, 0, 1, 2, WAD, token.address, { from: USER0 });
      const proposal2Id = await fundingQueue.getProposalCount();
      await fundingQueue.stakeProposal(proposal2Id, colonyKey, colonyValue, colonyMask, colonySiblings, { from: USER0 });

      await fundingQueue.createProposal(1, UINT256_MAX, 0, 1, 2, WAD, token.address, { from: USER0 });
      const proposal3Id = await fundingQueue.getProposalCount();
      await fundingQueue.stakeProposal(proposal3Id, colonyKey, colonyValue, colonyMask, colonySiblings, { from: USER0 });

      // Put proposal2 in position 1 (3 wad support) and proposal3 in position 2 (1 wad support)
      await fundingQueue.backProposal(proposal2Id, WAD, proposal2Id, HEAD, user0Key, user0Value, user0Mask, user0Siblings, { from: USER0 });
      await fundingQueue.backProposal(proposal2Id, WAD.muln(2), HEAD, HEAD, user1Key, user1Value, user1Mask, user1Siblings, { from: USER1 });
      await fundingQueue.backProposal(proposal3Id, WAD, proposal3Id, proposal2Id, user0Key, user0Value, user0Mask, user0Siblings, { from: USER0 });

      // Can't put proposal in position 1
      await checkErrorRevert(
        fundingQueue.backProposal(proposalId, WAD.muln(2), proposalId, HEAD, user1Key, user1Value, user1Mask, user1Siblings, { from: USER1 }),
        "funding-queue-insufficient-support"
      );

      // Can't put proposal in position 3
      await checkErrorRevert(
        fundingQueue.backProposal(proposalId, WAD.muln(2), proposalId, proposal3Id, user1Key, user1Value, user1Mask, user1Siblings, { from: USER1 }),
        "funding-queue-excess-support"
      );

      // But can in position 2 (2 wad support) and bump proposal3 to position 3
      await fundingQueue.backProposal(proposalId, WAD.muln(2), proposalId, proposal2Id, user1Key, user1Value, user1Mask, user1Siblings, {
        from: USER1,
      });

      const nextProposalId = await fundingQueue.getNextProposalId(proposal2Id);
      expect(nextProposalId).to.eq.BN(proposalId);
    });

    it("can correctly update the queue after a proposal is cancelled", async () => {
      await fundingQueue.createProposal(1, UINT256_MAX, 0, 1, 2, WAD, token.address, { from: USER0 });
      const proposal2Id = await fundingQueue.getProposalCount();
      await fundingQueue.stakeProposal(proposal2Id, colonyKey, colonyValue, colonyMask, colonySiblings, { from: USER0 });

      // Put proposal in position 1 (2 wad support) and proposal2 in position 2 (1 wad support)
      await fundingQueue.backProposal(proposalId, WAD.muln(2), proposalId, HEAD, user1Key, user1Value, user1Mask, user1Siblings, { from: USER1 });
      await fundingQueue.backProposal(proposal2Id, WAD, proposal2Id, proposalId, user0Key, user0Value, user0Mask, user0Siblings, { from: USER0 });

      await fundingQueue.cancelProposal(proposalId, HEAD, { from: USER0 });

      const nextProposalId = await fundingQueue.getNextProposalId(HEAD);
      expect(nextProposalId).to.eq.BN(proposal2Id);
    });

    it("can correctly update the queue after removing support for a proposal", async () => {
      await fundingQueue.createProposal(1, UINT256_MAX, 0, 1, 2, WAD, token.address, { from: USER0 });
      const proposal2Id = await fundingQueue.getProposalCount();
      await fundingQueue.stakeProposal(proposal2Id, colonyKey, colonyValue, colonyMask, colonySiblings, { from: USER0 });

      // Put proposal in position 1 (2 wad support) and proposal2 in position 2 (1 wad support)
      await fundingQueue.backProposal(proposalId, WAD.muln(2), proposalId, HEAD, user1Key, user1Value, user1Mask, user1Siblings, { from: USER1 });
      await fundingQueue.backProposal(proposal2Id, WAD, proposal2Id, proposalId, user0Key, user0Value, user0Mask, user0Siblings, { from: USER0 });

      // Remove support for leading proposal, move to back of queue
      await fundingQueue.backProposal(proposalId, 0, HEAD, proposal2Id, user1Key, user1Value, user1Mask, user1Siblings, { from: USER1 });

      let nextProposalId;
      nextProposalId = await fundingQueue.getNextProposalId(HEAD);
      expect(nextProposalId).to.eq.BN(proposal2Id);

      // Remove support for (other) leading proposal, move to back of queue
      await fundingQueue.backProposal(proposal2Id, 0, HEAD, proposalId, user0Key, user0Value, user0Mask, user0Siblings, { from: USER0 });

      nextProposalId = await fundingQueue.getNextProposalId(HEAD);
      expect(nextProposalId).to.eq.BN(proposalId);
    });
  });

  describe("pinging funding proposals", async () => {
    let proposalId;

    beforeEach(async () => {
      await fundingQueue.createProposal(1, UINT256_MAX, 0, 1, 2, WAD, token.address, { from: USER0 });
      proposalId = await fundingQueue.getProposalCount();

      await fundingQueue.stakeProposal(proposalId, colonyKey, colonyValue, colonyMask, colonySiblings, { from: USER0 });
    });

    it("can transfer 1/2 of funds after one week, with full backing", async () => {
      // Back proposal with 100% of reputation
      await fundingQueue.backProposal(proposalId, WAD, proposalId, HEAD, user0Key, user0Value, user0Mask, user0Siblings, { from: USER0 });
      await fundingQueue.backProposal(proposalId, WAD.muln(2), HEAD, HEAD, user1Key, user1Value, user1Mask, user1Siblings, { from: USER1 });
      const balanceBefore = await colony.getFundingPotBalance(1, token.address);

      // Advance one week
      await forwardTime(SECONDS_PER_DAY * 7, this);
      await fundingQueue.pingProposal(proposalId);

      // So 1 - (1 - 1/2 * 1) = 1/2 (50.0%) of the balance should be transferred
      const balanceAfter = await colony.getFundingPotBalance(1, token.address);
      const amountTransferred = balanceBefore.sub(balanceAfter);
      const expectedTransferred = new BN("499999999998489825");
      expect(amountTransferred).to.eq.BN(expectedTransferred);
    });

    it("can transfer 1/3 of funds after one week, with 2/3 reputation backing", async () => {
      // Back proposal with 66% of reputation
      await fundingQueue.backProposal(proposalId, WAD.muln(2), proposalId, HEAD, user1Key, user1Value, user1Mask, user1Siblings, { from: USER1 });
      const balanceBefore = await colony.getFundingPotBalance(1, token.address);

      // Advance one week
      await forwardTime(SECONDS_PER_DAY * 7, this);
      await fundingQueue.pingProposal(proposalId);

      // So 1 - (1 - 1/2 * 2/3) = 1/3 (33.3%) of the balance should be transferred
      const balanceAfter = await colony.getFundingPotBalance(1, token.address);
      const amountTransferred = balanceBefore.sub(balanceAfter);
      const expectedTransferred = new BN("333743300899454444");
      expect(amountTransferred).to.eq.BN(expectedTransferred);
    });

    it("can transfer 1/6 of funds after one week, with 1/3 reputation backing", async () => {
      // Back proposal with 33% of reputation
      await fundingQueue.backProposal(proposalId, WAD, proposalId, HEAD, user0Key, user0Value, user0Mask, user0Siblings, { from: USER0 });
      const balanceBefore = await colony.getFundingPotBalance(1, token.address);

      // Advance two weeks
      await forwardTime(SECONDS_PER_DAY * 7, this);
      await fundingQueue.pingProposal(proposalId);

      // So 1 - (1 - 1/2 * 1/3) = 1/6 (16.6%) of the balance should be transferred
      const balanceAfter = await colony.getFundingPotBalance(1, token.address);
      const amountTransferred = balanceBefore.sub(balanceAfter);
      const expectedTransferred = new BN("167004575824999562");
      expect(amountTransferred).to.eq.BN(expectedTransferred);
    });

    it("can transfer 3/4 of funds after two weeks, with full backing", async () => {
      // Back proposal with 100% of reputation
      await fundingQueue.backProposal(proposalId, WAD, proposalId, HEAD, user0Key, user0Value, user0Mask, user0Siblings, { from: USER0 });
      await fundingQueue.backProposal(proposalId, WAD.muln(2), HEAD, HEAD, user1Key, user1Value, user1Mask, user1Siblings, { from: USER1 });
      const balanceBefore = await colony.getFundingPotBalance(1, token.address);

      // Advance two weeks
      await forwardTime(SECONDS_PER_DAY * 14, this);
      await fundingQueue.pingProposal(proposalId);

      // So 1 - (1 - 1/2 * 1) ** 2) = 3/4 (75.0%) of the balance should be transferred
      const balanceAfter = await colony.getFundingPotBalance(1, token.address);
      const amountTransferred = balanceBefore.sub(balanceAfter);
      const expectedTransferred = new BN("749999999998489825"); // close enough
      expect(amountTransferred).to.eq.BN(expectedTransferred);
    });

    it("can transfer 5/9 of funds after two weeks, with 2/3 reputation backing", async () => {
      // Back proposal with 66% of reputation
      await fundingQueue.backProposal(proposalId, WAD.muln(2), proposalId, HEAD, user1Key, user1Value, user1Mask, user1Siblings, { from: USER1 });
      const balanceBefore = await colony.getFundingPotBalance(1, token.address);

      // Advance two weeks
      await forwardTime(SECONDS_PER_DAY * 14, this);
      await fundingQueue.pingProposal(proposalId);

      // So 1 - (1 - 1/2 * 2/3) ** 2) = 5/9 (55.5%) of the balance should be transferred
      const balanceAfter = await colony.getFundingPotBalance(1, token.address);
      const amountTransferred = balanceBefore.sub(balanceAfter);
      const expectedTransferred = new BN("556102010903645098");
      expect(amountTransferred).to.eq.BN(expectedTransferred);
    });

    it("can transfer 11/36 of funds after two weeks, with 1/3 reputation backing", async () => {
      // Back proposal with 33% of reputation
      await fundingQueue.backProposal(proposalId, WAD, proposalId, HEAD, user0Key, user0Value, user0Mask, user0Siblings, { from: USER0 });
      const balanceBefore = await colony.getFundingPotBalance(1, token.address);

      // Advance two weeks
      await forwardTime(SECONDS_PER_DAY * 14, this);
      await fundingQueue.pingProposal(proposalId);

      // So 1 - (1 - 1/2 * 1/3) ** 2) = 11/36 (30.5%) of the balance should be transferred
      const balanceAfter = await colony.getFundingPotBalance(1, token.address);
      const amountTransferred = balanceBefore.sub(balanceAfter);
      const expectedTransferred = new BN("306118623303511095");
      expect(amountTransferred).to.eq.BN(expectedTransferred);
    });

    it("can transfer 3/4 of funds after two weeks, one week at a time, with full backing", async () => {
      // Back proposal with 100% of reputation
      await fundingQueue.backProposal(proposalId, WAD, proposalId, HEAD, user0Key, user0Value, user0Mask, user0Siblings, { from: USER0 });
      await fundingQueue.backProposal(proposalId, WAD.muln(2), HEAD, HEAD, user1Key, user1Value, user1Mask, user1Siblings, { from: USER1 });
      const balanceBefore = await colony.getFundingPotBalance(1, token.address);

      // Advance one week
      await forwardTime(SECONDS_PER_DAY * 7, this);
      await fundingQueue.pingProposal(proposalId);

      // Advance another week
      await forwardTime(SECONDS_PER_DAY * 7, this);
      await fundingQueue.pingProposal(proposalId);

      // So 1 - (1 - 1/2 * 1) ** 2) = 3/4 (75.0%) of the balance should be transferred
      const balanceAfter = await colony.getFundingPotBalance(1, token.address);
      const amountTransferred = balanceBefore.sub(balanceAfter);
      const expectedTransferred = new BN("749999999998489825"); // close enough
      expect(amountTransferred).to.eq.BN(expectedTransferred);
    });

    it("can transfer 5/9 of funds after two weeks, one week at a time, with 2/3 reputation backing", async () => {
      // Back proposal with 66% of reputation
      await fundingQueue.backProposal(proposalId, WAD.muln(2), proposalId, HEAD, user1Key, user1Value, user1Mask, user1Siblings, { from: USER1 });
      const balanceBefore = await colony.getFundingPotBalance(1, token.address);

      // Advance one week
      await forwardTime(SECONDS_PER_DAY * 7, this);
      await fundingQueue.pingProposal(proposalId);

      // Advance another week
      await forwardTime(SECONDS_PER_DAY * 7, this);
      await fundingQueue.pingProposal(proposalId);

      // So 1 - (1 - 1/2 * 2/3) ** 2) = 5/9 (55.5%) of the balance should be transferred
      const balanceAfter = await colony.getFundingPotBalance(1, token.address);
      const amountTransferred = balanceBefore.sub(balanceAfter);
      const expectedTransferred = new BN("556102010903645099");
      expect(amountTransferred).to.eq.BN(expectedTransferred);
    });

    it("can transfer 11/36 of funds after two weeks, one week at a time, with 1/3 reputation backing", async () => {
      // Back proposal with 33% of reputation
      await fundingQueue.backProposal(proposalId, WAD, proposalId, HEAD, user0Key, user0Value, user0Mask, user0Siblings, { from: USER0 });
      const balanceBefore = await colony.getFundingPotBalance(1, token.address);

      // Advance one week
      await forwardTime(SECONDS_PER_DAY * 7, this);
      await fundingQueue.pingProposal(proposalId);

      // Advance another week
      await forwardTime(SECONDS_PER_DAY * 7, this);
      await fundingQueue.pingProposal(proposalId);

      // So 1 - (1 - 1/2 * 1/3) ** 2) = 11/36 (30.5%) of the balance should be transferred
      const balanceAfter = await colony.getFundingPotBalance(1, token.address);
      const amountTransferred = balanceBefore.sub(balanceAfter);
      const expectedTransferred = new BN("306118623303511096");
      expect(amountTransferred).to.eq.BN(expectedTransferred);
    });

    it("can close a proposal once fulfilled", async () => {
      // Set balance to 2 WAD
      await token.mint(colony.address, WAD);
      await colony.claimColonyFunds(token.address);

      // Back proposal with 100% of reputation
      await fundingQueue.backProposal(proposalId, WAD, proposalId, HEAD, user0Key, user0Value, user0Mask, user0Siblings, { from: USER0 });
      await fundingQueue.backProposal(proposalId, WAD.muln(2), HEAD, HEAD, user1Key, user1Value, user1Mask, user1Siblings, { from: USER1 });

      // Actually just the null proposal but let's ignore that for now
      const nextId = await fundingQueue.getNextProposalId(proposalId);

      // Advance a little more than one week
      await forwardTime(SECONDS_PER_DAY * 8, this);
      const tx = await fundingQueue.pingProposal(proposalId);
      const blockTime = await getBlockTime(tx.receipt.blockNumber);

      const proposal = await fundingQueue.getProposal(proposalId);
      expect(proposal.state).to.eq.BN(STATE_COMPLETED);

      const headId = await fundingQueue.getNextProposalId(HEAD);
      expect(headId).to.eq.BN(nextId);

      // Make sure the next proposal's timestamp is also updated
      //   to the approximate completion time, at least 12 hours ago
      const nextProposal = await fundingQueue.getProposal(headId);
      expect(proposal.lastUpdated).to.eq.BN(nextProposal.lastUpdated);
      expect(proposal.lastUpdated).to.be.lte.BN(blockTime - SECONDS_PER_DAY / 2);

      // Can't cancel once completed
      await checkErrorRevert(fundingQueue.cancelProposal(proposalId, proposalId, { from: USER0 }), "funding-queue-already-completed");

      // Can reclaim stake after 10 days
      const obligationPre = await tokenLocking.getTotalObligation(USER0, token.address);
      expect(obligationPre).to.eq.BN(WAD.muln(3).divn(1000));

      await forwardTime(SECONDS_PER_DAY * 14, this);
      await fundingQueue.reclaimStake(proposalId);

      const obligationPost = await tokenLocking.getTotalObligation(USER0, token.address);
      expect(obligationPost).to.be.zero;
    });

    it("cannot ping a proposal if it not at the head of the queue", async () => {
      await checkErrorRevert(fundingQueue.pingProposal(proposalId), "funding-queue-proposal-not-head");
    });

    it("can ping a proposal before removing it from the head of the queue", async () => {
      await fundingQueue.createProposal(1, UINT256_MAX, 0, 1, 2, WAD, token.address, { from: USER0 });
      const proposal2Id = await fundingQueue.getProposalCount();
      await fundingQueue.stakeProposal(proposal2Id, colonyKey, colonyValue, colonyMask, colonySiblings, { from: USER0 });

      // Put proposal in position 1 (2 wad support) and proposal2 in position 2 (1 wad support)
      await fundingQueue.backProposal(proposalId, WAD.muln(2), proposalId, HEAD, user1Key, user1Value, user1Mask, user1Siblings, { from: USER1 });
      await fundingQueue.backProposal(proposal2Id, WAD, proposal2Id, proposalId, user0Key, user0Value, user0Mask, user0Siblings, { from: USER0 });

      // Advance a week
      await forwardTime(SECONDS_PER_DAY * 7, this);

      // Put proposal2 in position 1 (3 wad support), which should also ping the first proposal
      const balanceBefore = await colony.getFundingPotBalance(1, token.address);
      await fundingQueue.backProposal(proposal2Id, WAD.muln(2), proposalId, HEAD, user1Key, user1Value, user1Mask, user1Siblings, { from: USER1 });

      // So 1 - (1 - 1/2 * 2/3) = 1/3 (33.3%) of the balance should be transferred
      const balanceAfter = await colony.getFundingPotBalance(1, token.address);
      const amountTransferred = balanceBefore.sub(balanceAfter);
      const expectedTransferred = new BN("333743300899454444");
      expect(amountTransferred).to.eq.BN(expectedTransferred);
    });

    it("can transfer funds once per 10 seconds, regardless of pinging frequency", async () => {
      await fundingQueue.backProposal(proposalId, WAD, proposalId, HEAD, user0Key, user0Value, user0Mask, user0Siblings, { from: USER0 });

      const balanceBefore = await colony.getFundingPotBalance(1, token.address);
      let balanceAfter;

      // Advance five seconds
      await forwardTime(5, this);
      await fundingQueue.pingProposal(proposalId);

      balanceAfter = await colony.getFundingPotBalance(1, token.address);
      expect(balanceBefore.sub(balanceAfter)).to.be.zero;

      // Advance five seconds
      await forwardTime(5, this);
      await fundingQueue.pingProposal(proposalId);

      // Now a transfer occurs
      balanceAfter = await colony.getFundingPotBalance(1, token.address);
      expect(balanceBefore.sub(balanceAfter)).to.not.be.zero;
    });
  });
});
