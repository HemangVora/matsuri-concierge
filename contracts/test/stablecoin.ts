import { expect } from 'chai';
import { network } from 'hardhat';

const { ethers } = await network.create();

// Basic tests for the issuer-controlled stablecoin.
// 発行者管理ステーブルコインの基本テスト。

describe('MatsuriStablecoin', () => {
  it('mints and burns by issuer', async () => {
    const [issuer, user] = await ethers.getSigners();

    const Stablecoin = await ethers.getContractFactory('MatsuriStablecoin');
    const stablecoin = await Stablecoin.deploy('Matsuri Yen', 'MJPY', issuer.address);
    await stablecoin.waitForDeployment();

    await stablecoin.mint(user.address, 1000n);
    expect(await stablecoin.balanceOf(user.address)).to.equal(1000n);
    expect(await stablecoin.totalSupply()).to.equal(1000n);

    await stablecoin.burn(user.address, 400n);
    expect(await stablecoin.balanceOf(user.address)).to.equal(600n);
    expect(await stablecoin.totalSupply()).to.equal(600n);
  });

  it('rejects mint/burn by non-issuer', async () => {
    const [issuer, user] = await ethers.getSigners();

    const Stablecoin = await ethers.getContractFactory('MatsuriStablecoin');
    const stablecoin = await Stablecoin.deploy('Matsuri Yen', 'MJPY', issuer.address);
    await stablecoin.waitForDeployment();

    await expect(stablecoin.connect(user).mint(user.address, 1n))
      .to.be.revertedWithCustomError(stablecoin, 'OwnableUnauthorizedAccount')
      .withArgs(user.address);

    await stablecoin.mint(user.address, 2n);

    await expect(stablecoin.connect(user).burn(user.address, 1n))
      .to.be.revertedWithCustomError(stablecoin, 'OwnableUnauthorizedAccount')
      .withArgs(user.address);
  });
});
