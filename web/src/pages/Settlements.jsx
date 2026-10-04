import React, { useEffect, useState } from 'react';
import { Card, DatePicker, Statistic, Table, Tag } from 'antd';
import dayjs from 'dayjs';
import api, { BOOKING_STATUS } from '../api';

export default function Settlements() {
  const [range, setRange] = useState([dayjs('2026-10-01'), dayjs('2026-10-08')]);
  const [data, setData] = useState(null);

  const load = async (r = range) => {
    const d = await api.get('/settlements', {
      params: { from: r[0].format('YYYY-MM-DD'), to: r[1].format('YYYY-MM-DD') },
    });
    setData(d);
  };
  useEffect(() => { load(); }, []);

  if (!data) return <Card loading />;
  const { totals } = data;

  return (
    <div>
      <Card style={{ marginBottom: 16 }}>
        <DatePicker.RangePicker value={range} allowClear={false} onChange={(r) => { setRange(r); if (r?.[0]) load(r); }} />
        <span style={{ marginLeft: 12, color: '#888' }}>每笔订单的房费、加床、早餐、押金扣款、赔付、渠道佣金、补偿券全部列清</span>
      </Card>
      <Card style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', gap: 48, flexWrap: 'wrap' }}>
          <Statistic title="应收合计" value={totals.gross} prefix="¥" />
          <Statistic title="渠道佣金" value={totals.commission} prefix="-¥" valueStyle={{ color: '#cf1322' }} />
          <Statistic title="补偿支出" value={totals.compensation} prefix="-¥" valueStyle={{ color: '#cf1322' }} />
          <Statistic title="合作民宿房费" value={totals.partnerCost || 0} prefix="-¥" valueStyle={{ color: '#cf1322' }} />
          <Statistic title="超卖索赔到账" value={totals.claimSettled || 0} prefix="+¥" valueStyle={{ color: '#2f6b4f' }} />
          <Statistic title="押金扣款留存" value={totals.depositDeducted} prefix="+¥" />
          <Statistic title="净收入" value={totals.net} prefix="¥" valueStyle={{ color: '#2f6b4f', fontWeight: 700 }} />
        </div>
      </Card>
      <Card title="订单结算明细">
        <Table dataSource={data.list} rowKey="bookingId" size="middle" pagination={{ pageSize: 12 }}
          scroll={{ x: 1300 }} columns={[
            { title: '订单', dataIndex: 'code', width: 100, fixed: 'left' },
            { title: '客人', dataIndex: 'guestName', width: 100 },
            { title: '渠道', dataIndex: 'channel', width: 90 },
            { title: '房间', width: 110, render: (_, r) => `${r.roomCode} ${r.roomType}` },
            { title: '超卖处置', width: 110, render: (_, r) => r.relocatedToPartner
              ? <Tag color="purple">转住{r.relocatedToPartner}</Tag>
              : r.oversell ? <Tag color="blue">{r.oversell.resolutionType === 'upgrade' ? '店内升级' : '超卖处置'}</Tag> : '-' },
            { title: '状态', dataIndex: 'status', width: 90, render: (v) => <Tag color={BOOKING_STATUS[v]?.color}>{BOOKING_STATUS[v]?.text}</Tag> },
            { title: '房费', width: 90, align: 'right', render: (_, r) => `¥${r.lines[0].amount}` },
            { title: '加床', width: 80, align: 'right', render: (_, r) => `¥${r.lines[1].amount}` },
            { title: '早餐', width: 80, align: 'right', render: (_, r) => `¥${r.lines[2].amount}` },
            { title: '宠物费', width: 80, align: 'right', render: (_, r) => `¥${r.lines[3].amount}` },
            { title: '佣金', dataIndex: 'commission', width: 90, align: 'right', render: (v) => <span style={{ color: '#cf1322' }}>-¥{v}</span> },
            { title: '补偿', dataIndex: 'compensation', width: 80, align: 'right', render: (v) => v > 0 ? <span style={{ color: '#cf1322' }}>-¥{v}</span> : '-' },
            { title: '押金扣留', width: 90, align: 'right', render: (_, r) => r.deposit.deducted > 0 ? `+¥${r.deposit.deducted}` : '-' },
            { title: '押金退还', width: 90, align: 'right', render: (_, r) => r.deposit.returned > 0 ? `¥${r.deposit.returned}` : '-' },
            { title: '净收入', dataIndex: 'net', width: 100, align: 'right', fixed: 'right',
              render: (v) => <b style={{ color: '#2f6b4f' }}>¥{v}</b> },
          ]} />
      </Card>
    </div>
  );
}
