import React, { useEffect, useState } from 'react';
import { Card, DatePicker, Statistic, Table, Tag } from 'antd';
import dayjs from 'dayjs';
import api from '../api';

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
            { title: '结算口径', width: 110, render: (_, r) => r.channelSettlementBlocked
              ? <Tag color="geekblue">合作方价结算</Tag>
              : <Tag color="default">原渠道</Tag> },
            { title: '房费/代收', width: 100, align: 'right',
              render: (_, r) => `¥${r.lines.find((l) => l.label.startsWith('房费'))?.amount ?? 0}` },
            { title: '加床', width: 80, align: 'right', render: (_, r) => `¥${r.lines.find((l) => l.label === '加床费')?.amount ?? 0}` },
            { title: '早餐', width: 80, align: 'right', render: (_, r) => `¥${r.lines.find((l) => l.label === '早餐费')?.amount ?? 0}` },
            { title: '宠物费', width: 80, align: 'right', render: (_, r) => `¥${r.lines.find((l) => l.label === '宠物清洁费')?.amount ?? 0}` },
            { title: '佣金', dataIndex: 'commission', width: 90, align: 'right', render: (v) => v > 0 ? <span style={{ color: '#cf1322' }}>-¥{v}</span> : <Tag color="green">免收</Tag> },
            { title: '补偿', dataIndex: 'compensation', width: 80, align: 'right', render: (v) => v > 0 ? <span style={{ color: '#cf1322' }}>-¥{v}</span> : '-' },
            { title: '转住代付', width: 90, align: 'right', render: (_, r) => { const p = r.lines.find((l) => l.label.includes('代付')); return p ? <span style={{ color: '#cf1322' }}>-¥{Math.abs(p.amount)}</span> : '-'; } },
            { title: '押金扣留', width: 90, align: 'right', render: (_, r) => r.deposit.deducted > 0 ? `+¥${r.deposit.deducted}` : '-' },
            { title: '押金退还', width: 90, align: 'right', render: (_, r) => r.deposit.returned > 0 ? `¥${r.deposit.returned}` : '-' },
            { title: '净收入', dataIndex: 'net', width: 100, align: 'right', fixed: 'right',
              render: (v) => <b style={{ color: '#2f6b4f' }}>¥{v}</b> },
          ]}
          expandable={{ expandedRowRender: (r) => r.settlementNote ? (
            <div style={{ color: '#cf1322' }}>⚠ {r.settlementNote}
              {r.partner ? `（合作方：${r.partner.name}，距离 ${r.partner.distanceKm}km，满意度 ${r.partner.satisfaction ?? '未回访'}）` : ''}
            </div>
          ) : r.oversellReason ? <div>超卖原因：{r.oversellReason}（渠道责任：{r.channelResponsibility}）</div> : null }}
        />
      </Card>
    </div>
  );
}
