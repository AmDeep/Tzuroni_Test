import { type FormEvent, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import {
  getGetEvaluationReportQueryKey,
  getGetForecastDashboardQueryKey,
  getGetForecastHistoryQueryKey,
  getGetResearchRunQueryKey,
  useGetEvaluationReport,
  useGetForecastDashboard,
  useGetForecastHistory,
  useGetResearchRun,
  useImportHistoricalData,
  useGetHistoricalCorpus,
  useImportHistoricalCorpus,
  useSearchAssetNews,
  useStartResearchRun,
  type ForecastDashboard,
  type HistoricalImportInput,
  type HistoricalImportInputMarketCalendar,
  type NewsSearchResults,
  type ResearchRun,
} from '@workspace/api-client-react';
import {
  Activity, AlertCircle, ArrowDownToLine, ArrowUpRight, BarChart3, Check,
  ChevronDown, CircleHelp, Database, FileDown, FileText, FlaskConical,
  LoaderCircle, Newspaper, Plus, RefreshCw, Search, Upload, X,
} from 'lucide-react';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import { DataQualityPanel, OutlookPanel, ReinforcementPanel } from '@/components/reinforcement-panel';
import {
  Area, AreaChart, CartesianGrid, ComposedChart, Line, ResponsiveContainer,
  Tooltip as ChartTooltip, XAxis, YAxis,
} from 'recharts';
import { Route, Switch, useLocation, Router as WouterRouter } from 'wouter';

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 5 * 60 * 1000, refetchOnWindowFocus: false } },
});

function readCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === '"' && text[i + 1] === '"' && quoted) { cell += '"'; i += 1; }
    else if (char === '"') quoted = !quoted;
    else if (char === ',' && !quoted) { row.push(cell.trim()); cell = ''; }
    else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && text[i + 1] === '\n') i += 1;
      row.push(cell.trim()); if (row.some(Boolean)) rows.push(row);
      row = []; cell = '';
    } else cell += char;
  }
  row.push(cell.trim()); if (row.some(Boolean)) rows.push(row);
  return rows;
}

function toIso(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid timestamp: ${value}`);
  return date.toISOString();
}

function parseHistorical(postsFile: File | null, pricesFile: File | null, assetSymbol: string): Promise<HistoricalImportInput> {
  if (!postsFile || !pricesFile) return Promise.reject(new Error('Choose both a posts CSV and a price bars CSV.'));
  return Promise.all([postsFile.text(), pricesFile.text()]).then(([postsText, pricesText]) => {
    const postsRows = readCsv(postsText);
    const priceRows = readCsv(pricesText);
    const postHeaders = postsRows.shift()?.map((v) => v.toLowerCase()) ?? [];
    const priceHeaders = priceRows.shift()?.map((v) => v.toLowerCase()) ?? [];
    const col = (headers: string[], names: string[]) => headers.findIndex((h) => names.includes(h));
    const postTime = col(postHeaders, ['timestamp', 'created_at', 'date']);
    const postText = col(postHeaders, ['text', 'content', 'post']);
    const priceTime = col(priceHeaders, ['timestamp', 'date', 'time']);
    const closeCol = col(priceHeaders, ['close', 'adj_close', 'price']);
    if (postTime < 0 || postText < 0 || priceTime < 0 || closeCol < 0) {
      throw new Error('CSV headers must include timestamp + text for posts, and timestamp + close for prices.');
    }
    const optional = (row: string[], headers: string[], names: string[]) => {
      const index = col(headers, names);
      if (index < 0 || !row[index]) return undefined;
      const value = Number(row[index]);
      return Number.isFinite(value) && value >= 0 ? value : undefined;
    };
    const posts = postsRows.filter((r) => r[postTime] && r[postText]).map((r) => ({
      timestamp: toIso(r[postTime]),
      text: r[postText],
      likes: optional(r, postHeaders, ['likes', 'like_count']),
      reposts: optional(r, postHeaders, ['reposts', 'retweets', 'repost_count']),
      views: optional(r, postHeaders, ['views', 'view_count']),
      authorFollowers: optional(r, postHeaders, ['authorfollowers', 'followers', 'author_followers']),
    }));
    const priceBars = priceRows.filter((r) => r[priceTime] && r[closeCol]).map((r) => {
      const close = Number(r[closeCol]);
      if (!Number.isFinite(close) || close <= 0) throw new Error(`Invalid close value: ${r[closeCol]}`);
      return { timestamp: toIso(r[priceTime]), close };
    });
    if (posts.length > 10000) throw new Error('Posts CSV exceeds the 10,000-row import limit.');
    if (priceBars.length < 20 || priceBars.length > 1000) throw new Error('Price CSV must contain between 20 and 1,000 valid rows.');
    return { assetSymbol, posts, priceBars };
  });
}

function AppHome() {
  const cache = useQueryClient();
  const [asset, setAsset] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [lookbackDays, setLookbackDays] = useState('180');
  const [maxPosts, setMaxPosts] = useState('1000');
  const [actorId, setActorId] = useState('');
  const [costAssumptions, setCostAssumptions] = useState({ transactionCostBps: 1, slippageBps: 3, marketImpactBps: 1, annualBorrowRateBps: 300 });
  const [runId, setRunId] = useState('');
  const [selectedHistoryRunId, setSelectedHistoryRunId] = useState<string | null>(null);
  const [postsFile, setPostsFile] = useState<File | null>(null);
  const [pricesFile, setPricesFile] = useState<File | null>(null);
  const [marketCalendar, setMarketCalendar] = useState<HistoricalImportInputMarketCalendar | 'auto'>('auto');
  const [importPayload, setImportPayload] = useState<HistoricalImportInput | null>(null);
  const [importMessage, setImportMessage] = useState('');
  const [importError, setImportError] = useState('');
  const [news, setNews] = useState<NewsSearchResults | null>(null);
  const [newsError, setNewsError] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [notice, setNotice] = useState('');
  const normalizedAsset = useMemo(() => asset.trim().toUpperCase(), [asset]);
  const corpusActiveAsset = useRef(normalizedAsset);
  corpusActiveAsset.current = normalizedAsset;
  const corpusQuery = useGetHistoricalCorpus();
  const corpusImport = useImportHistoricalCorpus();
  const corpus = corpusQuery.data;
  const historyParams = useMemo(() => ({ asset: normalizedAsset }), [normalizedAsset]);
  const historyQueryKey = getGetForecastHistoryQueryKey(historyParams);
  const historyQuery = useGetForecastHistory(historyParams, {
    query: { queryKey: historyQueryKey, enabled: Boolean(normalizedAsset) },
  });
  const historyRuns = historyQuery.data ?? [];
  const selectedHistoryRun = historyRuns.find(
    (historyRun) => historyRun.id === selectedHistoryRunId && historyRun.status === 'completed',
  );
  const latestCompletedHistoryRun = historyRuns.find((historyRun) => historyRun.status === 'completed');
  const dashboardParams = useMemo(
    () => ({ asset: normalizedAsset, runId: selectedHistoryRunId ?? undefined }),
    [normalizedAsset, selectedHistoryRunId],
  );
  const dashboardQueryKey = getGetForecastDashboardQueryKey(dashboardParams);
  const dashboardQuery = useGetForecastDashboard(dashboardParams, {
    query: { queryKey: dashboardQueryKey, enabled: Boolean(normalizedAsset) },
  });
  const dashboard = dashboardQuery.data as ForecastDashboard | undefined;
  const noAssetDashboard: ForecastDashboard = {
    assetSymbol: 'Select an asset',
    status: 'empty',
    hasData: false,
    lastUpdated: null,
    currentPrice: null,
    sentimentScore: null,
    sentimentLabel: null,
    postCount: 0,
    priceCount: 0,
    series: [],
    forecast: [],
    metrics: [],
    sentimentCoverage: {
      postStartDate: null,
      postEndDate: null,
      activePostDays: 0,
      activePriceDays: 0,
      priceWindowDays: 0,
      coverageRatio: 0,
      isSparse: false,
    },
    latestFailedRun: null,
    summary: 'Enter an asset ticker and X search query to begin a research run, or import aligned historical CSV files.',
  };
  const startRun = useStartResearchRun();
  const importHistorical = useImportHistoricalData();
  const searchNews = useSearchAssetNews();
  const runQuery = useGetResearchRun(runId, {
    query: {
      queryKey: getGetResearchRunQueryKey(runId),
      enabled: Boolean(runId),
      refetchInterval: (query) => {
        const status = query.state.data?.status;
        return status && ['queued', 'scraping', 'training'].includes(status) ? 3000 : false;
      },
    },
  });
  const run = runQuery.data as ResearchRun | undefined;
  const reportRunId =
    selectedHistoryRun?.id ??
    latestCompletedHistoryRun?.id ??
    (run?.status === 'completed' && run.assetSymbol === normalizedAsset ? run.id : '');
  const reportParams = useMemo(() => ({ runId: reportRunId }), [reportRunId]);
  const reportKey = getGetEvaluationReportQueryKey(reportParams);
  const reportQuery = useGetEvaluationReport(reportParams, {
    query: { queryKey: reportKey, enabled: Boolean(reportRunId) },
  });

  useEffect(() => {
    if (run?.status === 'completed') {
      const completedAsset = run.assetSymbol.trim().toUpperCase();
      const completedHistoryParams = { asset: completedAsset };
      void cache.invalidateQueries({
        queryKey: getGetForecastHistoryQueryKey(completedHistoryParams),
      });
      void cache.invalidateQueries({
        queryKey: getGetForecastDashboardQueryKey({ asset: completedAsset }),
      });
      void cache.invalidateQueries({
        queryKey: getGetEvaluationReportQueryKey({ runId: run.id }),
      });
    }
  }, [run?.status, run?.id, run?.assetSymbol, cache]);

  const submitRun = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setNotice('');
    startRun.mutate({
      data: {
        assetSymbol: normalizedAsset,
        searchQuery: searchQuery.trim(),
        actorId: actorId.trim() || undefined,
        lookbackDays: Number(lookbackDays),
        maxPosts: Number(maxPosts),
        companyName: companyName.trim() || undefined,
        costAssumptions,
      },
    }, {
      onSuccess: (created) => {
        setRunId(created.id);
        setSelectedHistoryRunId(null);
        setNotice(`Run ${created.id} queued. Provider availability and rate limits may affect completion.`);
        void cache.invalidateQueries({ queryKey: historyQueryKey });
      },
      onError: (error) => setNotice(error instanceof Error ? error.message : 'Could not start the research run.'),
    });
  };

  const prepareImport = async () => {
    setImportError(''); setImportMessage('Reading CSV files…'); setImportPayload(null);
    try {
      if (!normalizedAsset) throw new Error('Enter an asset ticker before validating historical files.');
      const payload = await parseHistorical(postsFile, pricesFile, normalizedAsset);
      setImportPayload(payload);
      setImportMessage(`${payload.posts.length.toLocaleString()} posts and ${payload.priceBars.length.toLocaleString()} price bars parsed. Timestamps converted to UTC.`);
    } catch (error) {
      setImportMessage('');
      setImportError(error instanceof Error ? error.message : 'Unable to parse the selected CSV files.');
    }
  };

  const doImport = () => {
    if (!importPayload) return;
    setImportError('');
    importHistorical.mutate({ data: { ...importPayload, costAssumptions, ...(marketCalendar === 'auto' ? {} : { marketCalendar }) } }, {
      onSuccess: (created) => {
        setRunId(created.id);
        setSelectedHistoryRunId(null);
        setImportMessage(`Import accepted as run ${created.id}.`);
        void cache.invalidateQueries({ queryKey: historyQueryKey });
      },
      onError: (error) => setImportError(error instanceof Error ? error.message : 'Import failed.'),
    });
  };

  const doCorpusImport = () => {
    if (!corpus?.assets.some((item) => item.assetSymbol === normalizedAsset)) return;
    const requestedAsset = normalizedAsset;
    setImportError('');
    setImportMessage(`Backtesting the full ${requestedAsset} corpus. This can take a few minutes…`);
    corpusImport.mutate({ data: { assetSymbol: requestedAsset as 'AAPL' | 'AMZN' | 'GOOG' | 'MSFT' | 'TSLA', costAssumptions } }, {
      onSuccess: (created) => {
        void cache.invalidateQueries({ queryKey: getGetForecastHistoryQueryKey({ asset: created.assetSymbol }) });
        void cache.invalidateQueries({ queryKey: getGetForecastDashboardQueryKey({ asset: created.assetSymbol }) });
        if (corpusActiveAsset.current !== requestedAsset) return;
        setRunId(created.id);
        setSelectedHistoryRunId(created.id);
        setNews(null);
        setImportMessage(`Historical backtest saved: ${created.postCount.toLocaleString()} posts and ${created.priceCount.toLocaleString()} price sessions.`);
      },
      onError: (error) => {
        if (corpusActiveAsset.current !== requestedAsset) return;
        setImportMessage('');
        setImportError(error instanceof Error ? error.message : 'Corpus backtest failed.');
      },
    });
  };

  const doNewsSearch = () => {
    setNewsError('');
    searchNews.mutate({ data: { assetSymbol: normalizedAsset, companyName: companyName.trim() || undefined } }, {
      onSuccess: (results) => setNews(results),
      onError: (error) => { setNews(null); setNewsError(error instanceof Error ? error.message : 'News search could not be completed.'); },
    });
  };

  const downloadReport = () => {
    if (!reportQuery.data) return;
    const blob = new Blob([reportQuery.data.markdown], { type: 'text/markdown;charset=utf-8' });
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = href;
    anchor.download = `${reportQuery.data.assetSymbol.toLowerCase()}-${reportQuery.data.runId}-evaluation.md`;
    anchor.click();
    URL.revokeObjectURL(href);
  };

  return (
    <div className="min-h-[100dvh] bg-[var(--paper)] text-[var(--ink)]">
      <div className="flex min-h-[100dvh]">
        <aside className="hidden w-[232px] shrink-0 flex-col bg-[#25313c] text-[#f4f1e9] md:flex">
          <div className="border-b border-white/10 px-6 pb-6 pt-7">
            <div className="mb-7 flex items-center gap-3">
              <div className="grid h-9 w-9 place-items-center rounded-sm bg-[#a4c9b5] text-[#25313c]"><FlaskConical size={19} /></div>
              <div><div className="display text-[18px] font-semibold leading-none">CrowdWisdom</div><div className="mono mt-1 text-[9px] uppercase tracking-[.18em] text-[#9eaaa5]">Forecast Lab</div></div>
            </div>
            <p className="eyebrow !text-[#8f9d98]">Research console</p>
            <div className="mt-4 flex items-center gap-2 rounded border border-white/10 bg-white/[.04] px-3 py-2.5">
              <span className="h-1.5 w-1.5 rounded-full bg-[#a4c9b5]" />
              <span className="mono text-[11px] text-[#d8dfd9]">Workspace / public markets</span>
            </div>
          </div>
          <nav className="px-3 py-5">
            <p className="eyebrow px-3 pb-2 !text-[#7f8c88]">Workspace</p>
            <div className="flex items-center gap-3 rounded bg-white/[.09] px-3 py-3 text-sm text-[#f4f1e9]">
              <Activity size={16} className="text-[#a4c9b5]" /><span>Forecast overview</span><span className="ml-auto h-1.5 w-1.5 rounded-full bg-[#a4c9b5]" />
            </div>
            <div className="mt-1 flex items-center gap-3 px-3 py-3 text-sm text-[#9eaaa5]"><Database size={16} /><span>Data intake</span></div>
            <div className="flex items-center gap-3 px-3 py-3 text-sm text-[#9eaaa5]"><BarChart3 size={16} /><span>Evaluation</span></div>
          </nav>
          <div className="mt-auto border-t border-white/10 p-5">
            <div className="mb-3 flex items-center gap-2 text-[#a4c9b5]"><CircleHelp size={14} /><span className="eyebrow !text-[#a4c9b5]">Provider status</span></div>
            <p className="text-xs leading-5 text-[#aeb8b3]">Apify, market data and news availability depend on configured providers and their limits.</p>
            <div className="mono mt-5 text-[9px] tracking-wider text-[#76837f]">LAB BUILD · RESEARCH ONLY</div>
          </div>
        </aside>

        <main className="min-w-0 flex-1">
          <header className="flex items-center justify-between border-b border-[#dedbd1] bg-[#f7f5ef] px-5 py-4 md:px-9">
            <div className="flex items-center gap-2 text-xs text-[#778078]"><span className="hidden sm:inline">Research workspace</span><span className="hidden sm:inline">/</span><strong className="mono text-[#25313c]">{normalizedAsset || '—'}</strong><ChevronDown size={13} /></div>
            <div className="flex items-center gap-3">
              <span className="hidden text-[11px] text-[#778078] sm:inline">Data view is provider-dependent</span>
              <button type="button" onClick={() => dashboardQuery.refetch()} disabled={!normalizedAsset} data-testid="button-refresh-dashboard" className="flex items-center gap-2 border border-[#d8d5ca] bg-[#fbfaf6] px-3 py-2 text-xs font-semibold hover:bg-white disabled:cursor-not-allowed disabled:opacity-50">
                <RefreshCw size={13} className={dashboardQuery.isFetching ? 'animate-spin' : ''} /> Refresh
              </button>
            </div>
          </header>
          <div className="mx-auto max-w-[1500px] px-4 pb-14 pt-7 sm:px-7 lg:px-10">
            <div className="fade-up mb-7 flex flex-col justify-between gap-5 lg:flex-row lg:items-end">
              <div>
                <div className="eyebrow mb-2 flex items-center gap-2"><span className="h-px w-5 bg-[#c56b50]" /> Quantitative research / 01</div>
                <h1 className="display text-[36px] font-semibold leading-[1.05] sm:text-[48px]">Forecast workspace</h1>
                <p className="mt-2 max-w-xl text-sm leading-6 text-[#69736e]">Trace social signal to price behavior. Every view stays tied to observed data and out-of-sample evaluation.</p>
              </div>
              <div className="mono flex items-center gap-2 text-[10px] uppercase tracking-[.12em] text-[#788078]"><span className="h-2 w-2 rounded-full bg-[#c56b50]" /> No investment advice</div>
            </div>

            <section className="panel fade-up mb-5 overflow-hidden" style={{ animationDelay: '.04s' }}>
              <div className="grid lg:grid-cols-[1.15fr_.85fr]">
                <form onSubmit={submitRun} className="p-5 sm:p-6">
                  <div className="mb-5 flex items-start justify-between gap-4">
                    <div><p className="eyebrow">01 / Configure collection</p><h2 className="display mt-1 text-[22px] font-semibold">Start a research run</h2></div>
                    <span className="mono mt-1 rounded-sm bg-[#e7eee8] px-2 py-1 text-[9px] uppercase tracking-wider text-[#39725e]">Apify ingestion</span>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-12">
                    <label className="sm:col-span-3"><span className="eyebrow mb-1.5 block">Asset</span><input value={asset} onChange={(e) => { setAsset(e.target.value.toUpperCase()); setSelectedHistoryRunId(null); setImportPayload(null); setNews(null); setNewsError(''); }} maxLength={20} required data-testid="input-asset-symbol" className="h-10 w-full border border-[#d8d5ca] bg-[#f7f5ef] px-3 font-mono text-sm outline-none focus:border-[#2d8068]" placeholder="BTC-USD" /></label>
                    <label className="sm:col-span-9"><span className="eyebrow mb-1.5 block">Additional X keywords (optional)</span><input value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} maxLength={300} data-testid="input-search-query" className="h-10 w-full border border-[#d8d5ca] bg-[#f7f5ef] px-3 text-sm outline-none focus:border-[#2d8068]" placeholder="Ticker, cashtag and company keywords are generated automatically" /></label>
                    <label className="sm:col-span-4"><span className="eyebrow mb-1.5 block">Lookback · days</span><input type="number" min="1" max="180" value={lookbackDays} onChange={(e) => setLookbackDays(e.target.value)} data-testid="input-lookback-days" className="h-10 w-full border border-[#d8d5ca] bg-[#f7f5ef] px-3 font-mono text-sm outline-none focus:border-[#2d8068]" /></label>
                    <label className="sm:col-span-4"><span className="eyebrow mb-1.5 block">Post ceiling</span><input type="number" min="50" max="5000" step="50" value={maxPosts} onChange={(e) => setMaxPosts(e.target.value)} data-testid="input-max-posts" className="h-10 w-full border border-[#d8d5ca] bg-[#f7f5ef] px-3 font-mono text-sm outline-none focus:border-[#2d8068]" /></label>
                    <label className="sm:col-span-4"><span className="eyebrow mb-1.5 block">Apify actor ID <span className="normal-case tracking-normal">(optional)</span></span><input value={actorId} onChange={(e) => setActorId(e.target.value)} data-testid="input-apify-actor-id" className="h-10 w-full border border-[#d8d5ca] bg-[#f7f5ef] px-3 font-mono text-sm outline-none focus:border-[#2d8068]" placeholder="Provider default" /></label>
                  </div>
                  <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center">
                    <button disabled={startRun.isPending || !normalizedAsset} type="submit" data-testid="button-start-run" className="flex h-10 items-center justify-center gap-2 bg-[#2d8068] px-4 text-sm font-semibold text-white transition hover:bg-[#246b57] disabled:cursor-not-allowed disabled:opacity-50">
                      {startRun.isPending ? <LoaderCircle size={15} className="animate-spin" /> : <Plus size={15} />} Start collection run
                    </button>
                    <span className="text-[11px] leading-5 text-[#778078]">Provider constraints can limit coverage or delay updates.</span>
                  </div>
                  <fieldset className="mt-4 border-t border-[#dedbd1] pt-3">
                    <legend className="eyebrow px-1">Backtest cost assumptions · applies to runs and CSV imports</legend>
                    <div className="mt-2 grid grid-cols-2 gap-3">
                      {([
                        ['transactionCostBps', 'Commission · bps'],
                        ['slippageBps', 'Slippage · bps'],
                        ['marketImpactBps', 'Market impact · bps'],
                        ['annualBorrowRateBps', 'Annual borrow · bps'],
                      ] as const).map(([key, label]) => <label key={key} className="text-[11px] text-[#59665d]">{label}<input type="number" min="0" max="5000" step="0.1" required value={costAssumptions[key]} onChange={(e) => setCostAssumptions((old) => ({ ...old, [key]: Number(e.target.value) }))} data-testid={`input-${key}`} className="mt-1 h-9 w-full border border-[#d8d5ca] bg-[#f7f5ef] px-3 font-mono text-sm" /></label>)}
                    </div>
                    <p className="mt-2 text-[10px] text-[#778078]">1 bp = 0.01%. Execution costs are one-way and charged on turnover. Defaults are illustrative, not broker quotes. Reports show gross and net results.</p>
                  </fieldset>
                  {notice && <p role="status" data-testid="status-run-notice" className="mt-3 flex gap-2 text-xs text-[#39725e]"><Check size={14} className="shrink-0" />{notice}</p>}
                </form>
                <div className="border-t border-[#dedbd1] bg-[#f4f2eb] p-5 sm:p-6 lg:border-l lg:border-t-0">
                  <div className="flex items-start justify-between">
                    <div><p className="eyebrow">02 / Bring your own history</p><h2 className="display mt-1 text-[22px] font-semibold">Import CSV data</h2></div>
                    <Upload size={17} className="text-[#748078]" />
                  </div>
                  <p className="mt-2 text-xs leading-5 text-[#788078]">Supply aligned posts and daily price bars. Dates are normalized to ISO-8601 UTC before import.</p>
                  <p className="mt-1 text-[11px] leading-5 text-[#788078]">CSV calendars use ticker suffixes: .TO, .L, .DE, .PA, .AX, .HK or .T. Unsuffixed equities use U.S. sessions; unsupported markets are rejected.</p>
                  <label className="mt-3 block text-[11px] text-[#59665d]">Market calendar<select value={marketCalendar} onChange={(e) => setMarketCalendar(e.target.value as HistoricalImportInputMarketCalendar | 'auto')} data-testid="select-market-calendar" className="mt-1 h-9 w-full border border-[#d8d5ca] bg-[#f7f5ef] px-2 text-xs">
                    <option value="auto">Automatic (from ticker suffix)</option>
                    {(['XNYS','XTSE','XLON','XETR','XPAR','XASX','XHKG','XTKS','UTC-24/7'] as const).map((c) => <option key={c} value={c}>{c}</option>)}
                  </select></label>
                  <div className="mt-4 grid gap-3 sm:grid-cols-2">
                    <label className="block cursor-pointer border border-dashed border-[#c8c5bb] bg-[#faf9f4] p-3 hover:border-[#2d8068]">
                      <span className="eyebrow block">Posts CSV</span><span className="mt-1 block truncate text-xs text-[#788078]">{postsFile?.name || 'timestamp, text, likes…'}</span>
                      <input type="file" accept=".csv,text/csv" onChange={(e) => setPostsFile(e.target.files?.[0] ?? null)} data-testid="input-posts-csv" className="sr-only" />
                    </label>
                    <label className="block cursor-pointer border border-dashed border-[#c8c5bb] bg-[#faf9f4] p-3 hover:border-[#2d8068]">
                      <span className="eyebrow block">Price bars CSV</span><span className="mt-1 block truncate text-xs text-[#788078]">{pricesFile?.name || 'timestamp, close'}</span>
                      <input type="file" accept=".csv,text/csv" onChange={(e) => setPricesFile(e.target.files?.[0] ?? null)} data-testid="input-prices-csv" className="sr-only" />
                    </label>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button type="button" onClick={() => void prepareImport()} data-testid="button-validate-csv" disabled={!normalizedAsset || !postsFile || !pricesFile} className="border border-[#c8c5bb] px-3 py-2 text-xs font-semibold hover:bg-white disabled:opacity-40">Validate files</button>
                    <button type="button" onClick={doImport} data-testid="button-import-history" disabled={!normalizedAsset || !importPayload || importHistorical.isPending} className="flex items-center gap-2 bg-[#25313c] px-3 py-2 text-xs font-semibold text-white hover:bg-[#354653] disabled:opacity-40">
                      {importHistorical.isPending ? <LoaderCircle size={13} className="animate-spin" /> : <ArrowDownToLine size={13} />} Import history
                    </button>
                  </div>
                  <div className="mt-5 border-t border-[#dedbd1] pt-4" data-testid="panel-historical-corpus">
                    <h3 className="text-sm font-semibold">Licensed historical corpus</h3>
                    {corpusQuery.isError ? <p role="alert" className="mt-2 text-xs text-[#a34437]">Could not load corpus availability.</p> : corpus?.available ? <>
                      <p className="mt-2 text-[11px] leading-5 text-[#778078]"><a href={corpus.sourceUrl} target="_blank" rel="noreferrer" className="underline">{corpus.title}</a> · {corpus.license}<br />{corpus.uniqueUsablePosts?.toLocaleString()} unique usable posts · {corpus.startDate?.slice(0, 10)}–{corpus.endDate?.slice(0, 10)}. Full population, no sampling.</p>
                      <label className="mt-3 block text-[11px] text-[#59665d]">Company for historical backtest<select value={corpus.assets.some((item) => item.assetSymbol === normalizedAsset) ? normalizedAsset : ''} onChange={(event) => { setAsset(event.target.value); setSelectedHistoryRunId(null); setImportPayload(null); setNews(null); setNewsError(''); setImportMessage(''); setImportError(''); }} data-testid="select-corpus-asset" className="mt-1 h-10 w-full border border-[#d8d5ca] bg-[#f7f5ef] px-2 text-xs">
                        <option value="" disabled>Choose one company</option>
                        {corpus.assets.map((item) => <option key={item.assetSymbol} value={item.assetSymbol}>{item.assetSymbol} · {item.postCount.toLocaleString()} posts · {item.sessionCount} sessions</option>)}
                      </select></label>
                      <button type="button" onClick={doCorpusImport} disabled={corpusImport.isPending || !corpus.assets.some((item) => item.assetSymbol === normalizedAsset)} data-testid="button-import-corpus" className="mt-3 flex h-10 items-center gap-2 bg-[#2d8068] px-4 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50">{corpusImport.isPending ? <LoaderCircle size={14} className="animate-spin" /> : <Database size={14} />} Run historical backtest</button>
                      <p className="mt-2 text-[10px] leading-4 text-[#8f513c]">Historical, not live. Uses the cost assumptions on the left. Followers/views are unavailable; retrospective engagement may contain information not available at signal time.</p>
                    </> : <p className="mt-2 text-xs text-[#778078]">{corpusQuery.isLoading ? 'Checking corpus availability…' : 'The historical corpus has not been installed.'}</p>}
                  </div>
                  {importMessage && <p data-testid="status-import-message" className="mt-2 text-[11px] text-[#39725e]">{importMessage}</p>}
                  {importError && <p role="alert" data-testid="status-import-error" className="mt-2 flex items-center gap-1.5 text-[11px] text-[#a34437]"><AlertCircle size={13} />{importError}</p>}
                </div>
              </div>
            </section>

            {runId && <RunStatus run={run} isLoading={runQuery.isLoading} isError={runQuery.isError} onRetry={() => runQuery.refetch()} />}

            <ForecastRunHistoryPanel
              asset={normalizedAsset}
              runs={historyQuery.data}
              selectedRunId={selectedHistoryRun?.id ?? latestCompletedHistoryRun?.id ?? null}
              isLoading={historyQuery.isLoading}
              isError={historyQuery.isError}
              onRetry={() => historyQuery.refetch()}
              onSelect={(historyRun) => setSelectedHistoryRunId(historyRun.id)}
            />

            {dashboardQuery.isLoading ? <DashboardSkeleton /> :
              dashboardQuery.isError ? <div className="panel my-5 flex items-center justify-between p-5" data-testid="status-dashboard-error"><div className="flex items-center gap-3 text-sm"><AlertCircle size={18} className="text-[#c56b50]" />Dashboard data could not be loaded. The provider may be unavailable.</div><button onClick={() => dashboardQuery.refetch()} data-testid="button-retry-dashboard" className="text-xs font-semibold underline">Retry</button></div> :
              dashboard ? <><DashboardSection dashboard={dashboard} /><ReinforcementPanel rl={dashboard.reinforcementLearning} /><OutlookPanel dashboard={dashboard} isHistoricalSelection={Boolean(selectedHistoryRunId && latestCompletedHistoryRun && selectedHistoryRunId !== latestCompletedHistoryRun.id)} /></> :
              !normalizedAsset ? <DashboardSection dashboard={noAssetDashboard} /> :
              <div className="panel my-5 p-6 text-sm text-[#778078]" data-testid="status-dashboard-empty">No dashboard response is available for this asset.</div>}

            <div className="mt-5 grid gap-5 xl:grid-cols-[1.1fr_.9fr]">
              <NewsPanel asset={normalizedAsset} companyName={companyName} setCompanyName={setCompanyName} news={news ?? dashboard?.newsContext ?? null} error={newsError} loading={searchNews.isPending} onSearch={doNewsSearch} />
              <ReportPanel report={reportQuery.data} isLoading={reportQuery.isLoading} isError={reportQuery.isError} hasCompletedRun={Boolean(reportRunId)} onDownload={downloadReport} onRetry={() => reportQuery.refetch()} />
            </div>
            <footer className="mt-8 flex flex-col justify-between gap-2 border-t border-[#dedbd1] pt-4 text-[10px] leading-5 text-[#7b817b] sm:flex-row">
              <span>Research tooling only. Forecasts and metrics are descriptive outputs, not financial advice.</span>
              <span className="mono">Missing values are shown as unavailable; no results are simulated.</span>
            </footer>
          </div>
        </main>
      </div>
    </div>
  );
}

function RunStatus({ run, isLoading, isError, onRetry }: { run?: ResearchRun; isLoading: boolean; isError: boolean; onRetry: () => void }) {
  const steps = ['queued', 'scraping', 'training', 'completed'];
  const currentIndex = run ? steps.indexOf(run.status) : 0;
  return <section className="panel mb-5 border-l-[3px] border-l-[#c56b50] p-4 sm:px-5" data-testid="section-run-progress">
    <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2"><p className="eyebrow">Active collection</p>{run?.id && <span className="mono truncate text-[10px] text-[#788078]" data-testid="text-run-id">{run.id}</span>}</div>
        {isLoading ? <div className="mt-2 h-5 w-56 animate-pulse bg-[#e7e4da]" /> :
          isError ? <p className="mt-1 text-sm text-[#a34437]" data-testid="status-run-error">Unable to retrieve run status.</p> :
          <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-1 text-xs">
            <span className="font-semibold capitalize" data-testid="status-run">{run?.status || 'Queued'}</span>
            <span className="mono text-[#788078]">{run?.postCount ?? 0} posts · {run?.priceCount ?? 0} bars</span>
            {run?.actorRunId && <span className="mono text-[#788078]">Actor {run.actorRunId}</span>}
          </div>}
      </div>
      {isError ? <button onClick={onRetry} data-testid="button-retry-run-status" className="text-xs underline">Retry status</button> :
        <div className="flex min-w-[min(100%,420px)] items-center gap-1">
          {steps.map((step, index) => <div key={step} className="flex flex-1 items-center gap-1.5">
            <span className={`grid h-6 w-6 shrink-0 place-items-center rounded-full text-[9px] ${index <= currentIndex && run?.status !== 'failed' ? 'bg-[#2d8068] text-white' : 'bg-[#e7e4da] text-[#788078]'}`}>{run?.status === 'failed' && index === currentIndex ? <X size={12} /> : index < currentIndex ? <Check size={12} /> : index + 1}</span>
            <span className={`hidden text-[9px] capitalize sm:inline ${index === currentIndex ? 'font-semibold text-[#25313c]' : 'text-[#92968f]'}`}>{step}</span>
            {index < steps.length - 1 && <span className="h-px flex-1 bg-[#dedbd1]" />}
          </div>)}
        </div>}
    </div>
    {run?.status === 'failed' && <p role="alert" data-testid="status-run-failed" className="mt-3 text-xs text-[#a34437]">{run.error || 'Run failed without an error description.'}</p>}
  </section>;
}

function ForecastRunHistoryPanel({
  asset,
  runs,
  selectedRunId,
  isLoading,
  isError,
  onRetry,
  onSelect,
}: {
  asset: string;
  runs?: ResearchRun[];
  selectedRunId: string | null;
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
  onSelect: (run: ResearchRun) => void;
}) {
  return (
    <section className="panel mb-5 p-4 sm:p-5" data-testid="panel-run-history">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="eyebrow">Run archive</p>
          <h2 className="display mt-1 text-[20px] font-semibold">
            Forecast history{asset ? ` · ${asset}` : ''}
          </h2>
        </div>
        <span className="mono text-[9px] uppercase tracking-wider text-[#788078]">
          Up to 50 recent runs
        </span>
      </div>
      {!asset ? (
        <p className="border border-dashed border-[#dedbd1] p-4 text-xs leading-5 text-[#838a82]">
          Enter an asset ticker to browse its completed and failed runs.
        </p>
      ) : isLoading ? (
        <div className="h-20 animate-pulse bg-[#efede5]" data-testid="status-history-loading" />
      ) : isError ? (
        <div className="flex items-center justify-between gap-3 border border-[#dfc6ad] bg-[#f6eee3] p-4">
          <p className="text-xs text-[#8e5540]" role="alert" data-testid="status-history-error">
            Run history could not be loaded.
          </p>
          <button type="button" onClick={onRetry} className="text-xs font-semibold underline">
            Retry
          </button>
        </div>
      ) : !runs?.length ? (
        <p className="border border-dashed border-[#dedbd1] p-4 text-xs leading-5 text-[#838a82]" data-testid="status-history-empty">
          No research runs have been saved for this asset yet.
        </p>
      ) : (
        <div className="max-h-[340px] divide-y divide-[#ebe9e1] overflow-y-auto" data-testid="list-run-history">
          {runs.map((run) => {
            const isCompleted = run.status === 'completed';
            const isSelected = run.id === selectedRunId;
            const statusTone = isCompleted
              ? 'bg-[#e7eee8] text-[#39725e]'
              : run.status === 'failed'
                ? 'bg-[#f4e5df] text-[#a34437]'
                : 'bg-[#efede5] text-[#788078]';
            const timestamp = new Date(run.startedAt);
            const timeLabel = Number.isNaN(timestamp.getTime())
              ? 'Date unavailable'
              : timestamp.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
            const contents = (
              <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`mono rounded-sm px-2 py-1 text-[9px] uppercase tracking-wider ${statusTone}`}>
                      {run.status}
                    </span>
                    <span className="text-[11px] text-[#69736e]">{timeLabel}</span>
                    <span className="mono text-[9px] text-[#899188]">
                      {run.actorId === 'historical-csv-import' ? 'CSV import' : 'Apify'}
                    </span>
                    {isSelected && (
                      <span className="mono text-[9px] uppercase tracking-wider text-[#2d8068]">
                        Selected
                      </span>
                    )}
                  </div>
                  <p className="mono mt-1 text-[10px] text-[#788078]">
                    {run.postCount.toLocaleString()} posts · {run.priceCount.toLocaleString()} price bars
                  </p>
                  {run.status === 'failed' && (
                    <p className="mt-1 line-clamp-2 text-[10px] leading-4 text-[#a34437]" data-testid={`text-history-error-${run.id}`}>
                      {run.error || 'Run failed without an error message.'}
                    </p>
                  )}
                </div>
                {isCompleted && (
                  <span className="shrink-0 text-[10px] font-semibold text-[#39725e]">
                    View forecast
                  </span>
                )}
              </div>
            );
            return isCompleted ? (
              <button
                key={run.id}
                type="button"
                onClick={() => onSelect(run)}
                aria-pressed={isSelected}
                data-testid={`button-history-run-${run.id}`}
                className={`block w-full px-3 py-3 text-left transition hover:bg-[#f7f5ef] ${isSelected ? 'bg-[#f4f2eb] ring-1 ring-inset ring-[#a4c9b5]' : ''}`}
              >
                {contents}
              </button>
            ) : (
              <div key={run.id} className="px-3 py-3" data-testid={`row-history-run-${run.id}`}>
                {contents}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function DashboardSkeleton() {
  return <div className="animate-pulse" data-testid="status-dashboard-loading">
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{[0,1,2,3].map((i) => <div key={i} className="panel h-[112px] bg-[#efede5]" />)}</div>
    <div className="mt-5 grid gap-5 xl:grid-cols-[1.4fr_.8fr]"><div className="panel h-[340px] bg-[#efede5]" /><div className="panel h-[340px] bg-[#efede5]" /></div>
  </div>;
}

function DashboardSection({ dashboard }: { dashboard: ForecastDashboard }) {
  const hasSeries = dashboard.series?.length > 0;
  const price = dashboard.currentPrice == null ? '—' : dashboard.currentPrice.toLocaleString(undefined, { style: 'currency', currency: 'USD' });
  const coverage = dashboard.sentimentCoverage;
  const coveragePercent = (coverage.coverageRatio * 100).toFixed(1);
  const postDateSpan = coverage.postStartDate && coverage.postEndDate
    ? `${coverage.postStartDate} to ${coverage.postEndDate} (${dashboard.marketCalendar ?? 'UTC legacy'})`
    : 'No usable post dates';
  return <div className="fade-up">
    {dashboard.marketCalendar && <p className="mb-4 text-xs leading-5 text-[#69736e]" data-testid="text-market-calendar">Trading calendar: <strong>{dashboard.marketCalendar}</strong>{dashboard.marketTimezone && ` · ${dashboard.marketTimezone}`}{dashboard.marketExchange && ` · ${dashboard.marketExchange}`}{dashboard.marketCalendarSource && ` · ${dashboard.marketCalendarSource === 'provider' ? 'Exchange metadata' : 'Ticker convention'}`}</p>}
    {dashboard.historicalAsOf && <div role="status" data-testid="status-historical-asof" className="mb-4 border border-[#dfc6ad] bg-[#f6eee3] p-4 text-xs leading-5 text-[#795a27]"><strong>Historical evaluation as of {dashboard.historicalAsOf} — not a current trading signal.</strong><p>Source: <a href={dashboard.sourceUrl} target="_blank" rel="noreferrer" className="underline">{dashboard.sourceTitle}</a> · {dashboard.sourceLicense}. Full source provenance and limitations are included in the evaluation report.</p></div>}
    {dashboard.latestFailedRun && <div role="alert" data-testid="status-latest-failed-run" className="mb-4 flex flex-col gap-1 border border-[#dfb7aa] bg-[#f8ece7] p-4 text-xs text-[#8f4034] sm:flex-row sm:items-start sm:justify-between">
      <div><p className="font-semibold">Most recent import failed</p><p className="mt-1">{dashboard.latestFailedRun.error || 'The run failed without an error description.'}</p></div>
      <span className="mono mt-1 shrink-0 text-[10px] sm:mt-0" data-testid="text-latest-failed-run-id">Run {dashboard.latestFailedRun.id}</span>
    </div>}
    {dashboard.dataQuality && <DataQualityPanel quality={dashboard.dataQuality} />}
    {!dashboard.hasData && <div className="mb-4 flex gap-3 border border-[#dfc6ad] bg-[#f6eee3] p-4" data-testid="status-no-data">
      <AlertCircle size={17} className="mt-0.5 shrink-0 text-[#a96546]" /><div><p className="text-sm font-semibold">No observed data for {dashboard.assetSymbol}</p><p className="mt-1 text-xs leading-5 text-[#79746b]">The dashboard is empty. Start a provider run or import historical CSVs; forecasts and evaluation remain unavailable until data exists.</p></div>
    </div>}
    <section className={`mb-4 flex gap-3 border p-4 ${coverage.isSparse ? 'border-[#dfc6ad] bg-[#f6eee3]' : 'border-[#d8ded4] bg-[#f2f5ef]'}`} data-testid="panel-sentiment-coverage">
      <AlertCircle size={17} className={`mt-0.5 shrink-0 ${coverage.isSparse ? 'text-[#a96546]' : 'text-[#39725e]'}`} />
      <div className="min-w-0">
        <p className="text-sm font-semibold" data-testid="text-sentiment-coverage-heading">
          {coverage.isSparse ? 'Sparse social sentiment coverage' : 'Social sentiment coverage'}
        </p>
        <p className="mt-1 text-xs leading-5 text-[#69736e]" data-testid="text-sentiment-coverage">
          Posts span {postDateSpan} across {coverage.activePostDays.toLocaleString()} active post {coverage.activePostDays === 1 ? 'day' : 'days'}. Posts appeared on {coverage.activePriceDays.toLocaleString()} of {coverage.priceWindowDays.toLocaleString()} price days ({coveragePercent}%).
        </p>
        {coverage.isSparse && <p className="mt-1 text-xs leading-5 text-[#8f513c]">Forecasts and evaluation remain available, but sentiment features have limited coverage for this price window.</p>}
      </div>
    </section>
    <div className="mb-5 grid grid-cols-2 gap-3 xl:grid-cols-4">
      <Kpi label="Asset / latest close" value={price} sub={`${dashboard.priceCount.toLocaleString()} price observations`} testId="value-current-price" />
      <Kpi label="Sentiment signal" value={dashboard.sentimentScore == null ? '—' : dashboard.sentimentScore.toFixed(3)} sub={dashboard.sentimentLabel || 'No sentiment label'} testId="value-sentiment-score" accent />
      <Kpi label="Posts collected" value={dashboard.postCount.toLocaleString()} sub={dashboard.postCount ? 'Observed posts in current dataset' : 'No posts available'} testId="value-post-count" />
      <Kpi label="Last updated" value={dashboard.lastUpdated ? new Date(dashboard.lastUpdated).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '—'} sub={dashboard.lastUpdated ? new Date(dashboard.lastUpdated).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', timeZoneName: 'short' }) : 'No timestamp supplied'} testId="value-last-updated" />
    </div>

    <div className="grid gap-5 xl:grid-cols-[1.38fr_.82fr]">
      <section className="panel min-w-0 p-4 sm:p-5" data-testid="panel-series">
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div><p className="eyebrow">03 / Observed data</p><h2 className="display mt-1 text-[20px] font-semibold">Price &amp; sentiment series</h2></div>
          <div className="flex gap-4 pt-1 text-[10px] text-[#778078]"><span className="flex items-center gap-1.5"><i className="h-[2px] w-4 bg-[#2d8068]" />Close</span><span className="flex items-center gap-1.5"><i className="h-[2px] w-4 bg-[#c56b50]" />Sentiment</span></div>
        </div>
        {hasSeries ? <div className="grid-paper h-[230px] w-full" data-testid="chart-price-sentiment">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={dashboard.series.map((point) => ({ ...point, sessionLabel: point.sessionDate ?? point.timestamp }))} margin={{ top: 12, right: 14, bottom: 0, left: 0 }}>
              <CartesianGrid stroke="#dcded5" strokeDasharray="3 5" vertical={false} />
              <XAxis dataKey="sessionLabel" tickFormatter={(v) => new Date(v).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: /^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? 'UTC' : dashboard.marketTimezone })} tick={{ fontSize: 9, fill: '#838b84' }} tickLine={false} axisLine={false} minTickGap={32} />
              <YAxis yAxisId="price" tick={{ fontSize: 9, fill: '#838b84' }} tickLine={false} axisLine={false} width={46} domain={['auto', 'auto']} />
              <YAxis yAxisId="sentiment" orientation="right" domain={[-1, 1]} tick={{ fontSize: 9, fill: '#838b84' }} tickLine={false} axisLine={false} width={30} />
              <ChartTooltip labelFormatter={(v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? `${v} · ${dashboard.marketCalendar}` : new Date(String(v)).toLocaleString(undefined, { timeZone: dashboard.marketTimezone })} formatter={(value, name) => [typeof value === 'number' ? value.toFixed(3) : value, name === 'close' ? 'Close' : 'Sentiment']} contentStyle={{ border: '1px solid #dedbd1', borderRadius: 3, fontSize: 11, background: '#fbfaf6' }} />
              <Area yAxisId="price" dataKey="close" type="monotone" stroke="#2d8068" fill="#2d8068" fillOpacity={0.1} strokeWidth={2} connectNulls={false} />
              <Line yAxisId="sentiment" dataKey="sentimentScore" type="monotone" stroke="#c56b50" strokeWidth={1.6} dot={false} connectNulls={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </div> : <ChartEmpty title="Price and sentiment series unavailable" detail="No observed time-series rows have been returned for this asset." testId="empty-series" />}
        <div className="mt-3 flex flex-wrap justify-between gap-2 border-t border-[#e5e2d9] pt-3 text-[10px] text-[#80867f]">
          <span>Observed rows: <b className="mono text-[#3c4b44]">{dashboard.series?.length ?? 0}</b></span>
          <span>Post volume and returns appear only where supplied.</span>
        </div>
      </section>
      <section className="panel p-4 sm:p-5" data-testid="panel-forecast-matrix">
        <div className="mb-4 flex items-start justify-between"><div><p className="eyebrow">04 / Model output</p><h2 className="display mt-1 text-[20px] font-semibold">Forecast matrix</h2></div><span className="mono rounded bg-[#f0eee6] px-2 py-1 text-[9px] text-[#727a73]">H+0 — H+5</span></div>
        {dashboard.forecast?.length ? <div className="scrollbar-thin overflow-x-auto">
          <table className="w-full min-w-[430px] text-left text-xs">
            <thead><tr className="border-b border-[#dedbd1] text-[9px] uppercase tracking-wider text-[#838b84]"><th className="pb-2 font-medium">Horizon</th><th className="pb-2 text-right font-medium">Est. close</th><th className="pb-2 text-right font-medium">Return</th><th className="pb-2 text-right font-medium">Interval</th></tr></thead>
            <tbody>{[0, 1, 2, 3, 4, 5].map((horizon) => {
              const f = dashboard.forecast.find((item) => item.horizon === horizon);
              const nowcast = horizon === 0 && dashboard.modelVersion === 'session-qlearning-v1';
              const pc = f?.predictedClose ?? null; const pr = f?.predictedReturn ?? null;
              return <tr key={horizon} data-testid={`row-forecast-h${horizon}`} className="border-b border-[#ebe9e1] last:border-0">
                <td className="py-3 font-semibold">H+{horizon}{nowcast && <span className="mono ml-1 text-[8px] uppercase text-[#788078]" data-testid="text-h0-nowcast">nowcast</span>}</td><td className="mono py-3 text-right">{pc == null ? 'Unavailable' : pc.toLocaleString(undefined, { style: 'currency', currency: 'USD' })}</td><td className={`mono py-3 text-right ${pr != null && pr > 0 ? 'text-[#2d8068]' : pr != null && pr < 0 ? 'text-[#b45f49]' : ''}`}>{pr == null ? 'Unavailable' : `${(pr * 100).toFixed(2)}%`}</td>
                <td className="mono py-3 text-right text-[10px] text-[#778078]">{!f || f.lowerBound == null || f.upperBound == null ? '—' : `${f.lowerBound.toFixed(2)}–${f.upperBound.toFixed(2)}`}</td>
              </tr>;
            })}</tbody>
          </table>
        </div> : <ChartEmpty title="No forecast estimates returned" detail="The model has not produced horizon values for this dataset." testId="empty-forecast" />}
        <p className="mt-3 border-t border-[#e5e2d9] pt-3 text-[10px] leading-4 text-[#80867f]">Model outputs are estimates, not observed prices. An absent interval is not inferred.{dashboard.modelVersion === 'session-qlearning-v1' ? ' H+0 is a model nowcast from prior-session data, not the observed close.' : ' Legacy runs: H+0 reflects the original model output for that run.'}</p>
      </section>
    </div>

    <section className="panel mt-5 p-4 sm:p-5" data-testid="panel-walk-forward">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div><p className="eyebrow">05 / Out-of-sample review</p><h2 className="display mt-1 text-[20px] font-semibold">Walk-forward performance</h2></div>
        <span className="flex items-center gap-1.5 text-[10px] text-[#788078]"><CircleHelp size={12} /> Metrics are reported by the evaluation pipeline</span>
      </div>
      {dashboard.metrics?.length ? <div className="scrollbar-thin overflow-x-auto">
        <table className="w-full min-w-[700px] text-left text-xs">
          <thead><tr className="border-b border-[#dedbd1] text-[9px] uppercase tracking-wider text-[#838b84]">{['Horizon','MAE','RMSE','R²','Directional accuracy','Samples'].map((v) => <th key={v} className="pb-2 pr-4 font-medium">{v}</th>)}</tr></thead>
          <tbody>{[0, 1, 2, 3, 4, 5].map((horizon) => {
            const m = dashboard.metrics.find((item) => item.horizon === horizon);
            return <tr key={horizon} data-testid={`row-metric-h${horizon}`} className="border-b border-[#ebe9e1] last:border-0">
              <td className="py-3 pr-4 font-semibold">H+{horizon}</td><td className="mono py-3 pr-4">{m ? fmtMetric(m.mae) : '—'}</td><td className="mono py-3 pr-4">{m ? fmtMetric(m.rmse) : '—'}</td><td className="mono py-3 pr-4">{m ? fmtMetric(m.r2) : '—'}</td><td className="mono py-3 pr-4">{m?.directionalAccuracy == null ? '—' : `${(m.directionalAccuracy * 100).toFixed(1)}%`}</td><td className="mono py-3 pr-4">{m ? m.sampleSize.toLocaleString() : '—'}</td>
            </tr>;
          })}</tbody>
        </table>
      </div> : <ChartEmpty title="Evaluation metrics unavailable" detail="No walk-forward metric rows were returned. Avoid interpreting forecasts without out-of-sample context." testId="empty-metrics" />}
      {dashboard.summary && <p data-testid="text-dashboard-summary" className="mt-4 whitespace-pre-line border-l-2 border-[#a4c9b5] pl-3 text-xs leading-5 text-[#65716a]">{dashboard.summary}</p>}
    </section>
  </div>;
}

function fmtMetric(value: number | null) { return value == null ? '—' : value.toFixed(4); }

function Kpi({ label, value, sub, testId, accent }: { label: string; value: string; sub: string; testId: string; accent?: boolean }) {
  return <div className={`panel min-w-0 border-t-2 ${accent ? 'border-t-[#c56b50]' : 'border-t-[#a4c9b5]'} p-4`} data-testid="card-kpi">
    <p className="eyebrow truncate">{label}</p><p data-testid={testId} className="display mt-2 truncate text-[27px] font-semibold leading-none">{value}</p><p className="mt-2 truncate text-[10px] text-[#81877f]">{sub}</p>
  </div>;
}

function ChartEmpty({ title, detail, testId }: { title: string; detail: string; testId: string }) {
  return <div data-testid={testId} className="grid min-h-[190px] place-items-center border border-dashed border-[#dedbd1] px-5 text-center">
    <div><div className="mx-auto mb-3 grid h-9 w-9 place-items-center rounded-full bg-[#efede5]"><BarChart3 size={16} className="text-[#899188]" /></div><p className="text-xs font-semibold text-[#58645c]">{title}</p><p className="mx-auto mt-1 max-w-xs text-[10px] leading-4 text-[#848a82]">{detail}</p></div>
  </div>;
}

function NewsPanel({ asset, companyName, setCompanyName, news, error, loading, onSearch }: { asset: string; companyName: string; setCompanyName: (v: string) => void; news: NewsSearchResults | null; error: string; loading: boolean; onSearch: () => void }) {
  return <section className="panel p-4 sm:p-5" data-testid="panel-news">
    <div className="flex items-start justify-between gap-3"><div><p className="eyebrow">06 / Linked context</p><h2 className="display mt-1 text-[20px] font-semibold">Recent news</h2></div><Newspaper size={17} className="mt-1 text-[#7f8981]" /></div>
    <div className="mt-4 flex flex-col gap-2 sm:flex-row">
      <label className="sr-only" htmlFor="company-name">Company name</label><input id="company-name" value={companyName} onChange={(e) => setCompanyName(e.target.value)} data-testid="input-company-name" placeholder="Company name (optional)" className="h-9 min-w-0 flex-1 border border-[#d8d5ca] bg-[#f7f5ef] px-3 text-xs outline-none focus:border-[#2d8068]" />
      <button onClick={onSearch} disabled={loading || !asset} data-testid="button-search-news" className="flex h-9 items-center justify-center gap-2 bg-[#25313c] px-3 text-xs font-semibold text-white hover:bg-[#354653] disabled:opacity-50">{loading ? <LoaderCircle size={13} className="animate-spin" /> : <Search size={13} />} Search {asset}</button>
    </div>
    {error && <p role="alert" data-testid="status-news-error" className="mt-3 text-xs text-[#a34437]">{error}</p>}
    {news && Object.keys(news.providerErrors).length > 0 && <div role="status" data-testid="status-news-partial" className="mt-3 border border-[#e8c991] bg-[#fbf5e8] px-3 py-2 text-[10px] leading-4 text-[#795a27]">
      Partial news results. {Object.entries(news.providerErrors).map(([provider, reason]) => `${provider === 'tavily' ? 'Tavily' : 'Exa'} unavailable: ${reason}`).join(' ')}
    </div>}
    {news === null && !error ? <div className="mt-4 grid min-h-[150px] place-items-center border border-dashed border-[#dedbd1] px-4 text-center"><p className="max-w-xs text-xs leading-5 text-[#838a82]">Search provider-linked coverage for this asset. Results appear only when returned by the configured news providers.</p></div> :
      news?.articles.length === 0 ? <div data-testid="empty-news" className="mt-4 grid min-h-[150px] place-items-center border border-dashed border-[#dedbd1] text-center text-xs text-[#838a82]">No linked articles were returned for this search.</div> :
        <div className="scrollbar-thin mt-3 max-h-[260px] divide-y divide-[#ebe9e1] overflow-y-auto">{news?.articles.map((article, index) => <article key={`${article.url}-${index}`} data-testid={`article-news-${index}`} className="py-3">
          <div className="flex flex-wrap items-center gap-2 text-[9px] text-[#858b83]"><span className="mono uppercase tracking-wider">{article.source}</span><span>·</span><time>{article.publishedAt ? new Date(article.publishedAt).toLocaleDateString() : 'Date unavailable'}</time><span>·</span><span data-testid={`text-news-providers-${index}`}>Via {article.providers.join(', ')}</span></div>
          <a href={article.url} target="_blank" rel="noreferrer" data-testid={`link-news-${index}`} className="mt-1 flex items-start justify-between gap-3 text-xs font-semibold leading-5 hover:text-[#2d8068]">{article.title}<ArrowUpRight size={13} className="mt-1 shrink-0 text-[#8a938b]" /></a>
          {article.snippet && <p className="mt-1 line-clamp-2 text-[10px] leading-4 text-[#788078]">{article.snippet}</p>}
        </article>)}</div>}
  </section>;
}

function ReportPanel({ report, isLoading, isError, hasCompletedRun, onDownload, onRetry }: { report?: { markdown: string; generatedAt: string; assetSymbol: string }; isLoading: boolean; isError: boolean; hasCompletedRun: boolean; onDownload: () => void; onRetry: () => void }) {
  return <section className="panel flex flex-col p-4 sm:p-5" data-testid="panel-report">
    <div className="flex items-start justify-between"><div><p className="eyebrow">07 / Reproducibility</p><h2 className="display mt-1 text-[20px] font-semibold">Evaluation report</h2></div><FileText size={17} className="mt-1 text-[#7f8981]" /></div>
    {!hasCompletedRun && !report && <div className="mt-4 grid min-h-[150px] flex-1 place-items-center border border-dashed border-[#dedbd1] px-5 text-center"><div><FileDown size={18} className="mx-auto mb-3 text-[#899188]" /><p className="text-xs font-semibold text-[#58645c]">Report requires a completed run</p><p className="mt-1 text-[10px] leading-4 text-[#848a82]">Complete a research or historical import run to request its Markdown evaluation.</p></div></div>}
    {isLoading && <div className="mt-4 min-h-[150px] animate-pulse bg-[#efede5]" data-testid="status-report-loading" />}
    {isError && <div className="mt-4 flex min-h-[150px] flex-col items-center justify-center gap-2 border border-dashed border-[#dedbd1] text-center"><p className="text-xs text-[#a34437]" data-testid="status-report-error">Report could not be loaded. It may not be ready yet.</p><button onClick={onRetry} data-testid="button-retry-report" className="text-xs underline">Try again</button></div>}
    {report && <div className="mt-4 flex min-h-[150px] flex-1 flex-col border border-[#dedbd1] bg-[#f7f5ef] p-4">
      <div className="flex items-center justify-between gap-2"><span className="mono text-[10px] uppercase text-[#788078]">{report.assetSymbol} · Markdown</span><span data-testid="text-report-generated" className="text-[9px] text-[#899188]">{new Date(report.generatedAt).toLocaleString()}</span></div>
      <p className="mt-3 line-clamp-5 whitespace-pre-wrap font-mono text-[10px] leading-5 text-[#69736e]" data-testid="text-report-preview">{report.markdown}</p>
      <button onClick={onDownload} data-testid="button-download-report" className="mt-auto flex h-9 items-center justify-center gap-2 self-start bg-[#2d8068] px-3 text-xs font-semibold text-white hover:bg-[#246b57]"><ArrowDownToLine size={14} /> Download Markdown</button>
    </div>}
  </section>;
}

function Router() {
  return <RoutedErrorBoundary><Switch><Route path="/" component={AppHome} /><Route component={NotFound} /></Switch></RoutedErrorBoundary>;
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function App() {
  return <QueryClientProvider client={queryClient}><TooltipProvider><WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}><Router /></WouterRouter><Toaster /></TooltipProvider></QueryClientProvider>;
}

export default App;
