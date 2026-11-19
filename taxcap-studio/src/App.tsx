import { useCallback, useEffect, useState } from 'react';
import { Download, FlaskConical, Globe, Activity, Database, Menu, Users, X } from 'lucide-react';
import { SandboxPanel } from './components/SandboxPanel';
import { ExtensionPackagerPanel } from './components/ExtensionPackagerPanel';
import { UsersAdminPanel } from './components/UsersAdminPanel';
import { PortalsPanel } from './components/PortalsPanel';
import { LogsPanel, type SolveLogItem } from './components/LogsPanel';
import {
  DatasetPanel,
  type DatasetSampleItem,
  type DatasetStatsData,
  type FewShotMode,
  type LocalModelsStatusData,
  type MemorySummaryData,
} from './components/DatasetPanel';
import type { PortalId } from './utils/captchaLogic';
import type { PortalLearnedHints } from './utils/portalRules';

type NavTab = 'sandbox' | 'extension' | 'users' | 'portals' | 'dataset' | 'logs';

interface HealthState {
  geminiConfigured: boolean;
  geminiKeyFormatValid: boolean;
  model: string;
  tokenRequired: boolean;
}

interface StatsState {
  total: number;
  successCount: number;
  errorCount: number;
  avgLatencyMs: number;
  logs: SolveLogItem[];
}

const NAV_ITEMS: { id: NavTab; label: string; title: string; icon: typeof FlaskConical }[] = [
  { id: 'sandbox', label: 'Mô phỏng & Kiểm thử', title: 'Mô phỏng & Kiểm thử Captcha', icon: FlaskConical },
  { id: 'extension', label: 'Tải & Cài Extension', title: 'Đóng gói & Cài đặt Chrome Extension', icon: Download },
  { id: 'users', label: 'Quản lý User', title: 'Quản lý Người dùng & Google Sheets', icon: Users },
  { id: 'portals', label: '4 Cổng Thuế & DVC', title: 'Quy tắc nhận diện 4 Cổng Thuế & DVC', icon: Globe },
  { id: 'dataset', label: 'Kho Dữ liệu', title: 'Kho Dữ liệu & Trí nhớ AI (Bước 1–3)', icon: Database },
  { id: 'logs', label: 'Nhật ký Proxy', title: 'Nhật ký giải Captcha qua Proxy', icon: Activity },
];

export default function App() {
  const [activeTab, setActiveTab] = useState<NavTab>('sandbox');
  const [mobileMenuOpen, setMobileMenuOpen] = useState<boolean>(false);
  const [staticHosting, setStaticHosting] = useState<boolean>(false);
  const [health, setHealth] = useState<HealthState>({
    geminiConfigured: true,
    geminiKeyFormatValid: true,
    model: 'gemini-3.1-flash-lite',
    tokenRequired: false,
  });
  const [stats, setStats] = useState<StatsState>({
    total: 0,
    successCount: 0,
    errorCount: 0,
    avgLatencyMs: 0,
    logs: [],
  });
  const [logsLoading, setLogsLoading] = useState<boolean>(false);
  const [datasetLoading, setDatasetLoading] = useState<boolean>(false);
  const [consolidatingMemory, setConsolidatingMemory] = useState<boolean>(false);
  const [memorySummary, setMemorySummary] = useState<MemorySummaryData | null>(null);
  const [localModels, setLocalModels] = useState<LocalModelsStatusData | null>(null);
  const [datasetData, setDatasetData] = useState<{
    stats: DatasetStatsData;
    samples: DatasetSampleItem[];
    portalHints?: Record<PortalId, PortalLearnedHints>;
  }>({
    stats: {
      total: 0,
      usable: 0,
      verified: 0,
      corrected: 0,
      rejected: 0,
      pending: 0,
      accuracyPercent: null,
      byPortal: [
        { portal: 'hddt', total: 0, usable: 0, verified: 0, corrected: 0, rejected: 0, pending: 0, accuracyPercent: null },
        { portal: 'tdt', total: 0, usable: 0, verified: 0, corrected: 0, rejected: 0, pending: 0, accuracyPercent: null },
        { portal: 'dvc', total: 0, usable: 0, verified: 0, corrected: 0, rejected: 0, pending: 0, accuracyPercent: null },
        { portal: 'tracuunnt', total: 0, usable: 0, verified: 0, corrected: 0, rejected: 0, pending: 0, accuracyPercent: null },
      ],
    },
    samples: [],
  });

  const loadHealth = useCallback(async () => {
    try {
      const res = await fetch('/api/health');
      const ct = res.headers.get('content-type') || '';
      if (!res.ok || !ct.includes('application/json')) {
        setStaticHosting(true);
        return;
      }
      const data = await res.json();
      setStaticHosting(false);
      setHealth({
        geminiConfigured: Boolean(data.geminiConfigured),
        geminiKeyFormatValid: data.geminiKeyFormatValid !== false,
        model: String(data.model || 'gemini-3.1-flash-lite'),
        tokenRequired: Boolean(data.tokenRequired),
      });
    } catch {
      setStaticHosting(true);
    }
  }, []);

  const loadStats = useCallback(async () => {
    setLogsLoading(true);
    try {
      const res = await fetch('/api/stats');
      const data = await res.json();
      if (res.ok) {
        setStats({
          total: data.total || 0,
          successCount: data.successCount || 0,
          errorCount: data.errorCount || 0,
          avgLatencyMs: data.avgLatencyMs || 0,
          logs: Array.isArray(data.logs) ? data.logs : [],
        });
      }
    } catch {
      // Ignore network hiccup
    } finally {
      setLogsLoading(false);
    }
  }, []);

  const loadMemory = useCallback(async () => {
    try {
      const res = await fetch('/api/memory');
      const data = await res.json();
      if (res.ok && data?.ok) {
        setMemorySummary(data.memory || null);
        setLocalModels(data.localModels || null);
      }
    } catch {
      // Ignore network hiccup
    }
  }, []);

  const loadDataset = useCallback(async () => {
    setDatasetLoading(true);
    try {
      const [dsRes] = await Promise.all([fetch('/api/dataset'), loadMemory()]);
      const data = await dsRes.json();
      if (dsRes.ok && data?.stats) {
        setDatasetData({
          stats: data.stats,
          samples: Array.isArray(data.samples) ? data.samples : [],
          portalHints: data.portalHints,
        });
      }
    } catch {
      // Ignore network hiccup
    } finally {
      setDatasetLoading(false);
    }
  }, [loadMemory]);

  useEffect(() => {
    loadHealth();
    loadStats();
    loadDataset();
  }, [loadHealth, loadStats, loadDataset]);

  const handleClearLogs = async () => {
    await fetch('/api/stats', { method: 'DELETE' }).catch(() => {});
    loadStats();
  };

  const handleClearDataset = async () => {
    await fetch('/api/dataset', { method: 'DELETE' }).catch(() => {});
    loadDataset();
  };

  const handleConsolidateMemory = async () => {
    setConsolidatingMemory(true);
    try {
      const res = await fetch('/api/memory/consolidate', { method: 'POST' });
      const data = await res.json();
      if (res.ok && data?.ok) {
        setMemorySummary(data.memory || null);
        setLocalModels(data.localModels || null);
      }
    } finally {
      setConsolidatingMemory(false);
    }
  };

  const handleChangeFewShotMode = async (fewShotMode: FewShotMode) => {
    const res = await fetch('/api/memory/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fewShotMode }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data?.ok) {
      setMemorySummary(data.memory || null);
    }
  };

  const currentNav = NAV_ITEMS.find((n) => n.id === activeTab) || NAV_ITEMS[0];

  const handleSelectTab = (tab: NavTab) => {
    setActiveTab(tab);
    setMobileMenuOpen(false);
    if (tab === 'logs') loadStats();
    if (tab === 'dataset') loadDataset();
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex">
      {/* Desktop Sidebar */}
      <aside className="hidden lg:flex lg:w-64 lg:flex-col lg:shrink-0 border-r border-slate-200 bg-white">
        <div className="h-14 flex items-center px-5 border-b border-slate-200">
          <span className="text-base font-bold tracking-tight text-slate-900">TaxCap Studio</span>
        </div>

        <nav aria-label="Điều hướng chính" className="flex-1 p-3 space-y-1">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const active = item.id === activeTab;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => handleSelectTab(item.id)}
                className={`w-full flex items-center gap-2.5 rounded-lg px-3 py-2 text-left text-xs font-medium transition-colors whitespace-nowrap ${
                  active
                    ? 'bg-sky-50 text-sky-800 font-semibold'
                    : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
                }`}
              >
                <Icon className={`h-4 w-4 shrink-0 ${active ? 'text-sky-700' : 'text-slate-400'}`} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>

        <div className="border-t border-slate-200 p-4 text-xs text-slate-500 space-y-1">
          {staticHosting ? (
            <>
              <div className="font-medium text-slate-700">Chế độ Web tĩnh (GitHub Pages)</div>
              <div>
                Extension: <span className="text-emerald-700 font-medium">Độc lập 100%</span>
              </div>
              <div>
                Quản lý User: <span className="font-medium text-slate-700">Google Sheets</span>
              </div>
            </>
          ) : (
            <>
              <div className="font-medium text-slate-700">Backend Proxy</div>
              <div>
                Model: <span className="font-mono text-slate-800">{health.model}</span>
              </div>
              <div>
                API Key:{' '}
                <span
                  className={
                    health.geminiConfigured && health.geminiKeyFormatValid
                      ? 'text-emerald-700 font-medium'
                      : 'text-amber-700 font-medium'
                  }
                >
                  {health.geminiConfigured && health.geminiKeyFormatValid
                    ? 'Đã cấu hình'
                    : 'Cần kiểm tra Secrets'}
                </span>
              </div>
            </>
          )}
        </div>
      </aside>

      {/* Mobile Drawer */}
      {mobileMenuOpen && (
        <div className="fixed inset-0 z-50 lg:hidden flex">
          <div
            className="fixed inset-0 bg-slate-900/40"
            onClick={() => setMobileMenuOpen(false)}
            aria-hidden="true"
          />
          <aside className="relative z-10 w-64 bg-white h-full border-r border-slate-200 flex flex-col">
            <div className="h-14 flex items-center justify-between px-4 border-b border-slate-200">
              <span className="text-base font-bold text-slate-900">TaxCap Studio</span>
              <button
                type="button"
                aria-label="Đóng menu"
                onClick={() => setMobileMenuOpen(false)}
                className="p-1.5 rounded-md text-slate-500 hover:bg-slate-100"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <nav className="flex-1 p-3 space-y-1">
              {NAV_ITEMS.map((item) => {
                const Icon = item.icon;
                const active = item.id === activeTab;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => handleSelectTab(item.id)}
                    className={`w-full flex items-center gap-2.5 rounded-lg px-3 py-2 text-left text-xs font-medium ${
                      active ? 'bg-sky-50 text-sky-800 font-semibold' : 'text-slate-600 hover:bg-slate-100'
                    }`}
                  >
                    <Icon className="h-4 w-4 shrink-0" />
                    <span>{item.label}</span>
                  </button>
                );
              })}
            </nav>
          </aside>
        </div>
      )}

      {/* Main Content Area */}
      <div className="flex-1 min-w-0 flex flex-col">
        <header className="h-14 border-b border-slate-200 bg-white px-4 sm:px-6 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              aria-label="Mở menu điều hướng"
              onClick={() => setMobileMenuOpen(true)}
              className="lg:hidden p-1.5 rounded-md border border-slate-200 text-slate-600 hover:bg-slate-50"
            >
              <Menu className="h-4 w-4" />
            </button>
            <h1 className="text-sm sm:text-base font-semibold text-slate-900 truncate">
              {currentNav.title}
            </h1>
          </div>

          <button
            type="button"
            onClick={() => handleSelectTab('extension')}
            className="whitespace-nowrap shrink-0 inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3.5 py-2 text-xs font-semibold text-white hover:bg-slate-800"
          >
            <Download className="h-3.5 w-3.5" />
            <span>Tải Extension</span>
          </button>
        </header>

        <main className="flex-1 p-4 sm:p-6 max-w-6xl w-full mx-auto">
          {activeTab === 'sandbox' && (
            <SandboxPanel
              geminiConfigured={health.geminiConfigured}
              geminiKeyFormatValid={health.geminiKeyFormatValid}
              onSolved={() => {
                loadStats();
                loadDataset();
              }}
            />
          )}
          {activeTab === 'extension' && (
            <ExtensionPackagerPanel tokenRequired={health.tokenRequired} />
          )}
          {activeTab === 'users' && <UsersAdminPanel />}
          {activeTab === 'portals' && <PortalsPanel />}
          {activeTab === 'dataset' && (
            <DatasetPanel
              stats={datasetData.stats}
              samples={datasetData.samples}
              portalHints={datasetData.portalHints}
              memorySummary={memorySummary}
              localModels={localModels}
              consolidating={consolidatingMemory}
              loading={datasetLoading}
              onRefresh={loadDataset}
              onClear={handleClearDataset}
              onLabelUpdated={loadDataset}
              onConsolidateMemory={handleConsolidateMemory}
              onChangeFewShotMode={handleChangeFewShotMode}
              onGoToSandbox={() => handleSelectTab('sandbox')}
            />
          )}
          {activeTab === 'logs' && (
            <LogsPanel
              total={stats.total}
              successCount={stats.successCount}
              errorCount={stats.errorCount}
              avgLatencyMs={stats.avgLatencyMs}
              logs={stats.logs}
              loading={logsLoading}
              onRefresh={loadStats}
              onClear={handleClearLogs}
              onGoToSandbox={() => handleSelectTab('sandbox')}
            />
          )}
        </main>
      </div>
    </div>
  );
}
