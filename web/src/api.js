import axios from 'axios';
import { message } from 'antd';

const api = axios.create({ baseURL: '/api', timeout: 15000 });

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

api.interceptors.response.use(
  (res) => res.data,
  (err) => {
    const msg = err.response?.data?.message || err.message || '请求失败';
    if (err.response?.status === 401) {
      localStorage.removeItem('token');
      localStorage.removeItem('user');
      if (!location.pathname.startsWith('/login')) location.href = '/login';
    }
    message.error(Array.isArray(msg) ? msg[0] : msg);
    return Promise.reject(err);
  },
);

export default api;

export const INCIDENT_TYPES = {
  late_checkout: '延迟退房', ac_failure: '空调故障', linen_delay: '布草延迟',
  extra_guests: '临时加人', pet_damage: '宠物损坏', breakfast_shortage: '早餐不足',
  oversell: '渠道超卖', bad_review: '差评', other: '其他',
};
export const MEMBER_LEVELS = { none: { text: '普卡', color: 'default' }, silver: { text: '银卡', color: 'blue' }, gold: { text: '金卡', color: 'gold' }, platinum: { text: '白金', color: 'purple' } };
export const OVERSELL_CASE_STATUS = {
  open: { text: '待处理', color: 'red' },
  arranged: { text: '方案已生成', color: 'orange' },
  accepted: { text: '客人已接受', color: 'blue' },
  resolved: { text: '已解决', color: 'green' },
};
export const OVERSELL_ITEM_STATUS = {
  pending: { text: '待出方案', color: 'red' },
  proposed: { text: '已提议', color: 'orange' },
  accepted: { text: '客人接受', color: 'green' },
  declined: { text: '客人拒绝', color: 'volcano' },
  kept: { text: '保留原房', color: 'blue' },
};
export const OVERSELL_OPTIONS = {
  keep: { text: '保留原房', color: 'blue' },
  upgrade: { text: '升级房', color: 'green' },
  partner: { text: '合作民宿转住', color: 'geekblue' },
  refund: { text: '退款补偿', color: 'orange' },
};
export const SETTLE_METHODS = { monthly: '月结', per_night: '逐晚现结', prepaid: '平台预付' };
export const SYNC_MODES = { auto: { text: '自动实时同步', color: 'green' }, manual: { text: '人工确认放房', color: 'orange' }, pause: { text: '暂停投放', color: 'red' } };
export const REVIEW_CATEGORIES = { hardware: '硬件', service: '服务', oversell: '超卖', food: '餐食' };
export const BOOKING_STATUS = {
  booked: { text: '待入住', color: 'blue' },
  checked_in: { text: '在住', color: 'green' },
  checked_out: { text: '已退房', color: 'default' },
  cancelled: { text: '已取消', color: 'red' },
};
export const ROOM_STATUS = {
  clean: { text: '已清洁', color: 'green' },
  dirty: { text: '待打扫', color: 'orange' },
  cleaning: { text: '打扫中', color: 'blue' },
  inspected: { text: '已验收', color: 'cyan' },
  maintenance: { text: '维修中', color: 'red' },
};
export const TASK_STATUS = {
  pending: { text: '待派单', color: 'orange' },
  assigned: { text: '已派单', color: 'blue' },
  in_progress: { text: '打扫中', color: 'processing' },
  done: { text: '已完成', color: 'green' },
  inspected: { text: '已验收', color: 'cyan' },
};
export const DIRTINESS = { light: '轻度', normal: '正常', heavy: '重度' };
export const INCIDENT_STATUS = { open: { text: '待处理', color: 'red' }, processing: { text: '处理中', color: 'orange' }, resolved: { text: '已解决', color: 'green' } };
