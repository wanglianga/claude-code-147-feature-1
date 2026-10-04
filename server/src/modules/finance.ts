import { Controller, Get, Module, Query } from '@nestjs/common';
import { InjectRepository, TypeOrmModule } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Booking, Compensation, OversellCase } from '../entities';
import { computeSettlement } from '../common/settlement';
import { round2 } from '../common/util';

// 结算中心：每笔订单的房费/加床/早餐/押金/赔付/佣金/补偿/超卖换房与索赔一目了然
@Controller('settlements')
export class SettlementController {
  constructor(
    @InjectRepository(Booking) private bookings: Repository<Booking>,
    @InjectRepository(Compensation) private compensations: Repository<Compensation>,
    @InjectRepository(OversellCase) private cases: Repository<OversellCase>,
  ) {}

  @Get()
  async list(@Query('from') from?: string, @Query('to') to?: string) {
    const qb = this.bookings.createQueryBuilder('b')
      .leftJoinAndSelect('b.channel', 'channel')
      .leftJoinAndSelect('b.room', 'room')
      .leftJoinAndSelect('b.roomType', 'roomType')
      .leftJoinAndSelect('b.relocatedToPartner', 'relocatedToPartner')
      // 超卖退款单不再产生房费收入，仅在超卖处置台账中体现
      .where('b.status != :st', { st: 'cancelled' })
      .andWhere('b.status != :refunded', { refunded: 'refunded' })
      .orderBy('b.checkIn', 'DESC');
    if (from) qb.andWhere('b.checkOut >= :from', { from });
    if (to) qb.andWhere('b.checkIn <= :to', { to });
    const rows = await qb.getMany();
    const comps = await this.compensations.find();
    const bookingIds = rows.map((b) => b.id);
    const ocRows = bookingIds.length
      ? await this.cases.find({
        where: { bookingId: In(bookingIds), settlementLocked: true },
        relations: ['partner'],
      }) : [];
    const ocOf = new Map(ocRows.map((c) => [c.bookingId, c]));
    const list = rows.map((b) =>
      computeSettlement(
        b,
        comps.filter((c) => c.bookingId === b.id && c.status !== 'cancelled'),
        ocOf.get(b.id) || null,
      ));
    const totals = list.reduce((acc, s) => ({
      gross: round2(acc.gross + s.gross),
      commission: round2(acc.commission + s.commission),
      compensation: round2(acc.compensation + s.compensation),
      partnerCost: round2(acc.partnerCost + s.partnerCost),
      claimSettled: round2(acc.claimSettled + s.claimSettled),
      depositDeducted: round2(acc.depositDeducted + s.deposit.deducted),
      net: round2(acc.net + s.net),
    }), { gross: 0, commission: 0, compensation: 0, partnerCost: 0, claimSettled: 0, depositDeducted: 0, net: 0 });
    return { list, totals };
  }
}

@Module({
  imports: [TypeOrmModule.forFeature([Booking, Compensation, OversellCase])],
  controllers: [SettlementController],
})
export class FinanceModule {}
