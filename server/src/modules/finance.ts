import { Controller, Get, Module, Query } from '@nestjs/common';
import { InjectRepository, TypeOrmModule } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Booking, Compensation, OversellItem } from '../entities';
import { computeSettlement } from '../common/settlement';
import { round2 } from '../common/util';

// 结算中心：每笔订单的房费/加床/早餐/押金/赔付/佣金/补偿一目了然
@Controller('settlements')
export class SettlementController {
  constructor(
    @InjectRepository(Booking) private bookings: Repository<Booking>,
    @InjectRepository(Compensation) private compensations: Repository<Compensation>,
    @InjectRepository(OversellItem) private oversellItems: Repository<OversellItem>,
  ) {}

  @Get()
  async list(@Query('from') from?: string, @Query('to') to?: string) {
    const qb = this.bookings.createQueryBuilder('b')
      .leftJoinAndSelect('b.channel', 'channel')
      .leftJoinAndSelect('b.room', 'room')
      .leftJoinAndSelect('b.roomType', 'roomType')
      .where('b.status != :st', { st: 'cancelled' })
      .orderBy('b.checkIn', 'DESC');
    if (from) qb.andWhere('b.checkOut >= :from', { from });
    if (to) qb.andWhere('b.checkIn <= :to', { to });
    const rows = await qb.getMany();
    const comps = await this.compensations.find();
    const oItems = await this.oversellItems.find({ relations: ['partner', 'upgradeRoom'] });
    const list = rows.map((b) =>
      computeSettlement(
        b,
        comps.filter((c) => c.bookingId === b.id && c.status !== 'cancelled'),
        oItems.filter((i) => i.bookingId === b.id),
      ));
    const totals = list.reduce((acc, s) => ({
      gross: round2(acc.gross + s.gross),
      commission: round2(acc.commission + s.commission),
      compensation: round2(acc.compensation + s.compensation),
      depositDeducted: round2(acc.depositDeducted + s.deposit.deducted),
      net: round2(acc.net + s.net),
    }), { gross: 0, commission: 0, compensation: 0, depositDeducted: 0, net: 0 });
    return { list, totals };
  }
}

@Module({
  imports: [TypeOrmModule.forFeature([Booking, Compensation, OversellItem])],
  controllers: [SettlementController],
})
export class FinanceModule {}
