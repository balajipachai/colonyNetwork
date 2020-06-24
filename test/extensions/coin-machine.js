/* globals artifacts */

import chai from "chai";
import bnChai from "bn-chai";

import { WAD } from "../../helpers/constants";
import { checkErrorRevert, forwardTime } from "../../helpers/test-helper";
import { setupColonyNetwork, setupRandomToken, setupRandomColony } from "../../helpers/test-data-generator";

const { expect } = chai;
chai.use(bnChai(web3.utils.BN));

const CoinMachine = artifacts.require("CoinMachine");
const CoinMachineFactory = artifacts.require("CoinMachineFactory");

contract("Coin Machine", (accounts) => {
  let colony;
  let token;
  let purchaseToken;

  let colonyNetwork;

  let coinMachine;
  let coinMachineFactory;

  const USER0 = accounts[0];
  const USER1 = accounts[1];

  before(async () => {
    colonyNetwork = await setupColonyNetwork();
    coinMachineFactory = await CoinMachineFactory.new();
  });

  beforeEach(async () => {
    ({ colony, token } = await setupRandomColony(colonyNetwork));
    purchaseToken = await setupRandomToken();

    await coinMachineFactory.deployExtension(colony.address);
    const coinMachineAddress = await coinMachineFactory.deployedExtensions(colony.address);
    coinMachine = await CoinMachine.at(coinMachineAddress);
    await colony.setRootRole(coinMachineAddress, true);

    await coinMachine.initialize(
      purchaseToken.address, // purchase token
      60 * 60, // period length
      10, // number of periods for averaging
      WAD.muln(100), // tokens per period
      WAD.muln(200), // max per period
      WAD // starting price
    );
  });

  describe("using the extension factory", async () => {
    it("can install the extension factory once if root and uninstall", async () => {
      ({ colony } = await setupRandomColony(colonyNetwork));
      await checkErrorRevert(coinMachineFactory.deployExtension(colony.address, { from: USER1 }), "colony-extension-user-not-root");
      await coinMachineFactory.deployExtension(colony.address, { from: USER0 });
      await checkErrorRevert(coinMachineFactory.deployExtension(colony.address, { from: USER0 }), "colony-extension-already-deployed");
      await coinMachineFactory.removeExtension(colony.address, { from: USER0 });
    });
  });

  describe.only("buying tokens", async () => {
    it("can buy tokens", async () => {
      await purchaseToken.mint(USER0, WAD, { from: USER0 });
      await purchaseToken.approve(coinMachine.address, WAD, { from: USER0 });

      await coinMachine.buyTokens(WAD, { from: USER0 });

      const balance = await token.balanceOf(USER0);
      expect(balance).to.eq.BN(WAD);
    });

    it("can buy up to the maximum amount of tokens per period", async () => {
      const maxPerPeriod = await coinMachine.getMaxPerPeriod();
      const tokensToBuy = maxPerPeriod.add(WAD);

      await purchaseToken.mint(USER0, tokensToBuy, { from: USER0 });
      await purchaseToken.approve(coinMachine.address, tokensToBuy, { from: USER0 });

      await coinMachine.buyTokens(tokensToBuy, { from: USER0 });

      const balance = await token.balanceOf(USER0);
      expect(balance).to.eq.BN(maxPerPeriod);
    });

    it("can buy tokens over multiple periods", async () => {
      const numPurchases = 3;

      const periodLength = await coinMachine.getPeriodLength();
      const tokensPerPeriod = await coinMachine.getTokensPerPeriod();
      const currPrice = await coinMachine.getCurrPrice();
      const totalCost = tokensPerPeriod.mul(currPrice).muln(numPurchases);

      await purchaseToken.mint(USER0, totalCost, { from: USER0 });
      await purchaseToken.approve(coinMachine.address, totalCost, { from: USER0 });

      for (let i = 0; i < numPurchases; i += 1) {
        await coinMachine.buyTokens(tokensPerPeriod, { from: USER0 });
        await forwardTime(periodLength.toNumber(), this);
      }

      const balance = await token.balanceOf(USER0);
      expect(balance).to.eq.BN(tokensPerPeriod.muln(numPurchases));
    });

    it("can adjust prices according to demand", async () => {
      const periodLength = await coinMachine.getPeriodLength();
      const maxPerPeriod = await coinMachine.getMaxPerPeriod();

      let currPrice;
      let tokenSurplus;
      let tokenDeficit;

      await purchaseToken.mint(USER0, maxPerPeriod.muln(10), { from: USER0 });
      await purchaseToken.approve(coinMachine.address, maxPerPeriod.muln(10), { from: USER0 });

      currPrice = await coinMachine.getCurrPrice();
      expect(currPrice).to.eq.BN(WAD);

      await coinMachine.buyTokens(maxPerPeriod, { from: USER0 });
      await forwardTime(periodLength.toNumber(), this);
      await coinMachine.updatePeriod();

      // Expect price to increase by 10% since we sold 200% in 1/10 of the periods
      currPrice = await coinMachine.getCurrPrice();
      tokenSurplus = await coinMachine.getTokenSurplus();
      tokenDeficit = await coinMachine.getTokenDeficit();
      expect(currPrice).to.eq.BN(WAD.divn(10).muln(11));
      expect(tokenSurplus).to.be.zero;
      expect(tokenDeficit).to.eq.BN(WAD.muln(100));

      await forwardTime(periodLength.toNumber(), this);
      await coinMachine.updatePeriod();

      // Expect price to return to baseline since we sold no tokens
      currPrice = await coinMachine.getCurrPrice();
      tokenSurplus = await coinMachine.getTokenSurplus();
      tokenDeficit = await coinMachine.getTokenDeficit();
      expect(currPrice).to.eq.BN(WAD);
      expect(tokenSurplus).to.be.zero;
      expect(tokenDeficit).to.be.zero;

      await forwardTime(periodLength.toNumber(), this);
      await coinMachine.updatePeriod();

      // Expect price to decrease by 10% to baseline since we sold 0% in 1/10 periods
      currPrice = await coinMachine.getCurrPrice();
      tokenSurplus = await coinMachine.getTokenSurplus();
      tokenDeficit = await coinMachine.getTokenDeficit();
      expect(currPrice).to.eq.BN(WAD.divn(10).muln(9));
      expect(tokenSurplus).to.eq.BN(WAD.muln(100));
      expect(tokenDeficit).to.be.zero;
    });
  });
});
