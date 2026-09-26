import { expect } from 'chai';
import { network } from 'hardhat';

const { ethers } = await network.create();

async function deploy() {
  const [owner, buyer, stallA, stallB] = await ethers.getSigners();
  const coin = await (await ethers.getContractFactory('MatsuriStablecoin')).deploy('Matsuri Yen', 'MJPY', owner.address);
  const voucher = await (await ethers.getContractFactory('MatsuriVoucher')).deploy(await coin.getAddress(), owner.address);
  return { owner, buyer, stallA, stallB, coin, voucher };
}

describe('MatsuriVoucher', () => {
  it('pays the stall configured for the item, not the treasury', async () => {
    const { owner, buyer, stallA, coin, voucher } = await deploy();
    const price = ethers.parseUnits('600', 18);
    await voucher.setEvent(1, price, 10, stallA.address);
    await coin.mint(buyer.address, price * 2n);
    await coin.connect(buyer).approve(await voucher.getAddress(), price * 2n);

    await expect(voucher.connect(buyer).buyVoucher(1, 2))
      .to.emit(voucher, 'VoucherPurchased')
      .withArgs(buyer.address, 1n, 2n, stallA.address, price * 2n);
    expect(await coin.balanceOf(stallA.address)).to.equal(price * 2n);
    expect(await coin.balanceOf(owner.address)).to.equal(0n);
  });

  it('returns the stall from eventInfo', async () => {
    const { stallB, voucher } = await deploy();
    await voucher.setEvent(2, 1n, 5, stallB.address);
    const [price, available, stall] = await voucher.eventInfo(2);
    expect([price, available, stall]).to.deep.equal([1n, 5n, stallB.address]);
  });

  it('rejects a zero stall address', async () => {
    const { voucher } = await deploy();
    await expect(voucher.setEvent(3, 1n, 5, ethers.ZeroAddress)).to.be.revertedWith('Stall required');
  });

  it('still blocks voucher transfers', async () => {
    const { buyer, stallA, coin, voucher } = await deploy();
    await voucher.setEvent(1, 1n, 5, stallA.address);
    await coin.mint(buyer.address, 1n);
    await coin.connect(buyer).approve(await voucher.getAddress(), 1n);
    await voucher.connect(buyer).buyVoucher(1, 1);
    await expect(
      voucher.connect(buyer).transferFrom(buyer.address, stallA.address, 1n)
    ).to.be.revertedWith('Transfers disabled');
  });
});
