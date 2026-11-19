import React, { useMemo, useState } from 'react';
import { RotateCw, Trash2 } from 'lucide-react';
import { PORTALS, type PortalId } from '../utils/captchaLogic';

export interface SolveLogItem {
  id: string;
  timestamp: string;
  portal: PortalId;
  status: 'ok' | 'error';
  codeMasked: string;
  latencyMs: number;
  message: string;
}

interface LogsPanelProps {
  total: number;
  successCount: number;
  errorCount: number;
  avgLatencyMs: number;
  logs: SolveLogItem[];
  loading: boolean;
  onRefresh: () => void;
  onClear: () => void;
  onGoToSandbox: () => void;
}

export const LogsPanel: React.FC<LogsPanelProps> = ({
  total,
  successCount,
  errorCount,
  avgLatencyMs,
  logs,
  loading,
  onRefresh,
  onClear,
  onGoToSandbox,
}) => {
  const [portalFilter, setPortalFilter] = useState<'all' | PortalId>('all');
  const [statusFilter, setStatusFilter] = useState<'all' | 'ok' | 'error'>('all');

  const filteredLogs = useMemo(() => {
    return logs.filter((item) => {
      if (portalFilter !== 'all' && item.portal !== portalFilter) return false;
      if (statusFilter !== 'all' && item.status !== statusFilter) return false;
      return true;
    });
  }, [logs, portalFilter, statusFilter]);

  const successRate = total > 0 ? Math.round((successCount / total) * 100) : 0;

  return (
    <div className="space-y-6">
      {/* Compact KPI Row */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <div className="rounded-xl border border-slate-200 bg-white px-4 py-3.5">
          <div className="text-xs text-slate-500">Tổng lượt gọi</div>
          <div className="mt-1 font-mono text-xl font-semibold tabular-nums text-slate-900">{total}</div>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white px-4 py-3.5">
          <div className="text-xs text-slate-500">Thành công</div>
          <div className="mt-1 font-mono text-xl font-semibold tabular-nums text-emerald-700">
            {successCount} <span className="text-xs font-normal text-slate-500">({successRate}%)</span>
          </div>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white px-4 py-3.5">
          <div className="text-xs text-slate-500">Lỗi / Chưa đọc</div>
          <div className="mt-1 font-mono text-xl font-semibold tabular-nums text-red-700">{errorCount}</div>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white px-4 py-3.5">
          <div className="text-xs text-slate-500">Độ trễ trung bình</div>
          <div className="mt-1 font-mono text-xl font-semibold tabular-nums text-slate-900">
            {avgLatencyMs} <span className="text-xs font-normal text-slate-500">ms</span>
          </div>
        </div>
      </div>

      {/* Filters & Log Table */}
      <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-5 py-3.5">
          <div className="flex flex-wrap items-center gap-2">
            <label htmlFor="log-portal-filter" className="sr-only">
              Lọc theo cổng
            </label>
            <select
              id="log-portal-filter"
              value={portalFilter}
              onChange={(e) => setPortalFilter(e.target.value as 'all' | PortalId)}
              className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 focus:border-sky-600 focus:outline-none"
            >
              <option value="all">Tất cả cổng</option>
              <option value="hddt">HĐĐT</option>
              <option value="tdt">Thuế ĐT</option>
              <option value="dvc">DVC Thuế</option>
              <option value="tracuunnt">Tra cứu NNT</option>
            </select>

            <div className="inline-flex items-center gap-1 rounded-lg bg-slate-100 p-0.5">
              {(['all', 'ok', 'error'] as const).map((st) => (
                <button
                  key={st}
                  type="button"
                  onClick={() => setStatusFilter(st)}
                  className={`whitespace-nowrap shrink-0 rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                    statusFilter === st ? 'bg-white text-slate-900 shadow-2xs' : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {st === 'all' ? 'Tất cả' : st === 'ok' ? 'Thành công' : 'Lỗi'}
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onRefresh}
              className="whitespace-nowrap shrink-0 inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
            >
              <RotateCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
              <span>Làm mới</span>
            </button>
            <button
              type="button"
              onClick={onClear}
              disabled={logs.length === 0}
              className="whitespace-nowrap shrink-0 inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              <Trash2 className="h-3.5 w-3.5" />
              <span>Xóa nhật ký</span>
            </button>
          </div>
        </div>

        {loading && logs.length === 0 ? (
          <div className="divide-y divide-slate-100 px-5 py-3">
            {[1, 2, 3].map((row) => (
              <div key={row} className="h-10 animate-pulse rounded bg-slate-100 my-2" />
            ))}
          </div>
        ) : filteredLogs.length === 0 ? (
          <div className="px-6 py-12 text-center space-y-3">
            <p className="text-sm font-medium text-slate-800">Chưa có lượt gọi Proxy nào được ghi nhận</p>
            <p className="text-xs text-slate-500">
              Hãy thử đọc một ảnh captcha trong Mô phỏng & Kiểm thử hoặc cài Extension để thấy nhật ký thực tế tại đây.
            </p>
            <button
              type="button"
              onClick={onGoToSandbox}
              className="rounded-lg bg-sky-700 px-4 py-2 text-xs font-semibold text-white hover:bg-sky-800"
            >
              Mở Mô phỏng & Kiểm thử
            </button>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-slate-200 bg-slate-50 text-slate-500">
                <tr>
                  <th className="px-5 py-2.5 font-medium">Thời gian</th>
                  <th className="px-4 py-2.5 font-medium">Cổng</th>
                  <th className="px-4 py-2.5 font-medium">Trạng thái</th>
                  <th className="px-4 py-2.5 font-medium">Mã (che)</th>
                  <th className="px-4 py-2.5 font-medium text-right">Độ trễ</th>
                  <th className="px-5 py-2.5 font-medium">Chi tiết</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filteredLogs.map((item) => (
                  <tr key={item.id} className="hover:bg-slate-50/70">
                    <td className="px-5 py-2.5 font-mono tabular-nums text-slate-600 whitespace-nowrap">
                      {new Date(item.timestamp).toLocaleTimeString('vi-VN')}
                    </td>
                    <td className="px-4 py-2.5 font-medium text-slate-800 whitespace-nowrap">
                      {PORTALS[item.portal]?.shortName || item.portal}
                    </td>
                    <td className="px-4 py-2.5 whitespace-nowrap">
                      <span
                        className={
                          item.status === 'ok'
                            ? 'font-medium text-emerald-700'
                            : 'font-medium text-red-700'
                        }
                      >
                        {item.status === 'ok' ? 'Thành công' : 'Lỗi'}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 font-mono tabular-nums text-slate-700 whitespace-nowrap">
                      {item.codeMasked}
                    </td>
                    <td className="px-4 py-2.5 font-mono tabular-nums text-right text-slate-700 whitespace-nowrap">
                      {item.latencyMs} ms
                    </td>
                    <td className="px-5 py-2.5 text-slate-600 max-w-xs truncate" title={item.message}>
                      {item.message}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};
