import React, { useEffect, useState } from 'react';
import {
  Alert, Button, Card, Col, DatePicker, Modal, Popconfirm, Row, Space, Statistic,
  Table, Tag, message,
} from 'antd';
import dayjs from 'dayjs';
import api from '../api';

const CLASS_COLORS = { 价格策略问题: 'blue', 履约能力问题: 'red', 个别客诉: 'gold' };

export default function Analytics() {
  const [range, setRange] = useState([dayjs('2026-10-01'), dayjs('2026-10-08')]);
  const [profit, setProfit] = useState(null);
  const [adjustment, setAdjustment] = useState(null);
  const [nextRange, setNextRange] = useState([dayjs('2026-12-31'), dayjs('2027-01-02')]);

  const load = async (r = range) => {
    const params = { from: r[0].format('YYYY-MM-DD'), to: r[1].format('YYYY-MM-DD') };
    const [p, a] = await Promise.all([
      api.get('/analytics/profit', { params }),
      api.get('/analytics/adjustment'),
    ]);
    setProfit(p); setAdjustment(a);
  };
  useEffect(() => { load(); }, []);

  if (!profit || !adjustment) return <Card loading />;
  const seg = profit.serviceSegments;

  const profitCols = [
    { title: '名称', dataIndex: 'name' },
    { title: '订单数', dataIndex: 'bookings', width: 80 },
    { title: '应收', dataIndex: 'gross', align: 'right', render: (v) => `¥${v}` },
    { title: '佣金', dataIndex: 'commission', align: 'right', render: (v) => `-¥${v}` },
    { title: '补偿', dataIndex: 'compensation', align: 'right', render: (v) => (v > 0 ? `-¥${v}` : '-') },
    { title: '押金留存', dataIndex: 'depositKept', align: 'right', render: (v) => (v > 0 ? `+¥${v}` : '-') },
    { title: '净收入', dataIndex: 'net', align: 'right', render: (v) => <b>¥{v}</b> },
    { title: '净利率', dataIndex: 'margin', width: 90, align: 'right',
      render: (v) => <span style={{ color: v < 70 ? '#cf1322' : '#2f6b4f' }}>{v}%</span> },
  ];

  return (
    <div>
      <Card style={{ marginBottom: 16 }}>
        <DatePicker.RangePicker value={range} allowClear={false} onChange={(r) => { setRange(r); if (r?.[0]) load(r); }} />
        <span style={{ marginLeft: 12, color: '#888' }}>旺季复盘：分渠道/房型利润、服务环节成本、问题归类与下一轮可售房量调整</span>
      </Card>

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={12}>
          <Card title="分渠道利润"><Table dataSource={profit.byChannel} columns={profitCols} rowKey="name" size="small" pagination={false} /></Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card title="分房型利润"><Table dataSource={profit.byRoomType} columns={profitCols} rowKey="name" size="small" pagination={false} /></Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card title="服务环节收入 vs 成本">
            <Row gutter={16}>
              <Col span={12}>
                <Card size="small" title="收入构成" style={{ marginBottom: 8 }}>
                  <Statistic title="房费" value={seg.revenue.roomFee} prefix="¥" />
                  <Statistic title="加床" value={seg.revenue.extraBed} prefix="¥" />
                  <Statistic title="早餐" value={seg.revenue.breakfast} prefix="¥" />
                  <Statistic title="宠物清洁" value={seg.revenue.petFee} prefix="¥" />
                  <Statistic title="应收合计" value={seg.grossTotal} prefix="¥" valueStyle={{ fontWeight: 700 }} />
                </Card>
              </Col>
              <Col span={12}>
                <Card size="small" title="成本构成">
                  <Statistic title="渠道佣金" value={seg.costs.commission} prefix="¥" />
                  <Statistic title="保洁成本" value={seg.costs.cleaning} prefix="¥" />
                  <Statistic title="布草洗涤" value={seg.costs.linen} prefix="¥" />
                  <Statistic title="早餐食材" value={seg.costs.breakfast} prefix="¥" />
                  <Statistic title="维修" value={seg.costs.maintenance} prefix="¥" />
                  <Statistic title="赔付补偿" value={seg.costs.compensation} prefix="¥" valueStyle={{ color: '#cf1322' }} />
                  <Statistic title="合作民宿房费(超卖转住)" value={seg.costs.partnerRelocation} prefix="¥" valueStyle={{ color: '#cf1322' }} />
                  <Statistic title="渠道超卖索赔到账" value={seg.costs.channelClaimRecovered} prefix="-¥" valueStyle={{ color: '#2f6b4f' }} />
                </Card>
              </Col>
            </Row>
            <Alert style={{ marginTop: 12 }} type={seg.net > 0 ? 'success' : 'error'} showIcon
              message={`旺季净利润 ¥${seg.net}（收入 ¥${seg.grossTotal} - 成本 ¥${seg.costTotal}）`} />
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card title="问题归类（价格策略 / 履约能力 / 个别客诉）">
            {profit.classification.map((c, i) => (
              <Alert key={i} style={{ marginBottom: 12 }} type={c.type === '履约能力问题' ? 'error' : c.type === '价格策略问题' ? 'info' : 'warning'} showIcon
                message={<Space><Tag color={CLASS_COLORS[c.type]}>{c.type}</Tag>{c.evidence}</Space>}
                description={`建议：${c.suggestion}`} />
            ))}
          </Card>
        </Col>
        <Col span={24}>
          <Card title="下一轮节假日可售房量调整（基于超卖/布草延迟/早餐投诉/补偿成本）"
            extra={
              <Space>
                <DatePicker.RangePicker value={nextRange} allowClear={false} onChange={(r) => r?.[0] && setNextRange(r)} />
                <Popconfirm title={`将调整后的可售房量应用到 ${nextRange[0].format('YYYY-MM-DD')} ~ ${nextRange[1].format('YYYY-MM-DD')}？`}
                  onConfirm={async () => {
                    await api.post('/analytics/apply-adjustment', {
                      from: nextRange[0].format('YYYY-MM-DD'), to: nextRange[1].format('YYYY-MM-DD'),
                    });
                    message.success('已应用，下一轮节假日库存已按调整后可售量生成');
                  }}>
                  <Button type="primary">应用到下一轮节假日</Button>
                </Popconfirm>
              </Space>
            }>
            <Table dataSource={adjustment.rows} rowKey="typeId" size="middle" pagination={false} columns={[
              { title: '房型', dataIndex: 'typeName', width: 140 },
              { title: '物理房量', dataIndex: 'total', width: 90 },
              { title: '建议可售', dataIndex: 'adjustedSellable', width: 100,
                render: (v, r) => <b style={{ color: v < r.total ? '#d46b08' : '#2f6b4f' }}>{v}</b> },
              { title: '下调', dataIndex: 'reduction', width: 80, render: (v) => v > 0 ? <Tag color="orange">-{v}</Tag> : '-' },
              { title: '超卖', dataIndex: 'oversellCount', width: 80, render: (v) => v > 0 ? <Tag color="red">{v}起</Tag> : '0' },
              { title: '早餐不足', dataIndex: 'breakfastShortages', width: 100, render: (v) => v > 0 ? `${v}天` : '0' },
              { title: '布草延迟率', dataIndex: 'linenDelayRate', width: 100, render: (v) => `${v}%` },
              { title: '补偿成本', dataIndex: 'compCost', width: 100, render: (v) => `¥${v}` },
              { title: '补偿占比', dataIndex: 'compRatio', width: 90, render: (v) => `${v}%` },
              { title: '调整原因', dataIndex: 'reasons', render: (v) => v.length ? v.map((r, i) => <div key={i} style={{ fontSize: 12 }}>· {r}</div>) : '履约良好，保持全量可售' },
            ]} />
          </Card>
        </Col>
      </Row>
    </div>
  );
}
