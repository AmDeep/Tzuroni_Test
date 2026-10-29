import { AlertCircle, ArrowDownToLine, FileText, ShieldCheck } from 'lucide-react';
import type { DataQuality, ForecastDashboard, PolicyBenchmark, PolicyStatistics, ReinforcementEvaluation } from '@workspace/api-client-react';

const pct = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? '—' : `${(v * 100).toFixed(2)}%`);
const num = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? '—' : v.toFixed(3));
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function StatsRow({ name, m, testId, strong }: { name: string; m?: PolicyStatistics; testId: string; strong?: boolean }) {
  return <tr data-testid={testId} className={`border-b border-[#ebe9e1] last:border-0 ${strong ? 'bg-[#f2f5ef]' : ''}`}>
    <td className={`py-2.5 pr-4 ${strong ? 'font-semibold' : ''}`}>{name}</td>
    <td className="mono py-2.5 pr-4 text-right">{num(m?.sharpe)}</td>
    <td className="mono py-2.5 pr-4 text-right">{num(m?.sortino)}</td>
    <td className="mono py-2.5 pr-4 text-right">{pct(m?.maxDrawdown)}</td>
    <td className="mono py-2.5 pr-4 text-right">{pct(m?.grossTotalReturn)}</td>
    <td className="mono py-2.5 text-right">{pct(m?.netTotalReturn)}</td>
  </tr>;
}

function StatsTable({ title, rows, prefix, lead }: { title: string; rows: PolicyBenchmark[]; prefix: string; lead?: PolicyBenchmark }) {
  return <div className="min-w-0">
    <p className="eyebrow mb-2">{title}</p>
    <div className="scrollbar-thin overflow-x-auto">
      <table className="w-full min-w-[560px] text-left text-xs">
        <thead><tr className="border-b border-[#dedbd1] text-[9px] uppercase tracking-wider text-[#838b84]">{['Policy', 'Sharpe', 'Sortino', 'Max DD', 'Gross', 'Net'].map((h, i) => <th key={h} className={`pb-2 pr-4 font-medium ${i ? 'text-right' : ''}`}>{h}</th>)}</tr></thead>
        <tbody>
          {lead && <StatsRow name={lead.name} m={lead.metrics} testId={`row-${prefix}-ensemble`} strong />}
          {rows.length ? rows.map((r, i) => <StatsRow key={`${r.name}-${i}`} name={r.name} m={r.metrics} testId={`row-${prefix}-${slug(r.name) || i}`} />) :
            <tr><td colSpan={6} className="py-3 text-[11px] text-[#838a82]">Not reported for this run.</td></tr>}
        </tbody>
      </table>
    </div>
  </div>;
}

export function DataQualityPanel({ quality }: { quality: DataQuality }) {
  const ok = quality.coverageQualified;
  return <section role={ok ? 'status' : 'alert'} data-testid="panel-data-quality" className={`mb-4 border p-4 ${ok ? 'border-[#d8ded4] bg-[#f2f5ef]' : 'border-[#dfb7aa] bg-[#f8ece7]'}`}>
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="flex gap-3">
        {ok ? <ShieldCheck size={18} className="mt-0.5 shrink-0 text-[#39725e]" /> : <AlertCircle size={18} className="mt-0.5 shrink-0 text-[#a34437]" />}
        <div>
          <p className="text-sm font-semibold" data-testid="status-coverage-qualified">{ok ? 'Coverage qualified' : 'Coverage not qualified — interpret results with caution'}</p>
          <p className="mt-1 text-xs leading-5 text-[#69736e]">Requested {quality.requestedStart.slice(0, 10)} to {quality.requestedEnd.slice(0, 10)} · observed {quality.observedStart?.slice(0, 10) ?? 'n/a'} to {quality.observedEnd?.slice(0, 10) ?? 'n/a'}</p>
        </div>
      </div>
      <div className="mono grid grid-cols-3 gap-4 text-[10px] text-[#59665d]">
        <div><span className="eyebrow block">Weeks</span><b data-testid="text-covered-weeks">{quality.coveredWeeks}/{quality.totalWeeks}</b> ({pct(quality.weeklyCoverageRatio)})</div>
        <div><span className="eyebrow block">Active sessions</span><b data-testid="text-active-session-ratio">{pct(quality.activeSessionRatio)}</b></div>
        <div><span className="eyebrow block">Post cap</span><b data-testid="text-post-cap">{quality.postCapReached ? 'Reached' : 'Not reached'}</b></div>
      </div>
    </div>
    {quality.warnings.length > 0 && <ul className="mt-3 space-y-1 border-t border-black/10 pt-3 text-xs leading-5 text-[#8f4034]" data-testid="list-data-quality-warnings">
      {quality.warnings.map((w, i) => <li key={i} data-testid={`text-data-warning-${i}`} className="flex gap-2"><span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-[#a34437]" />{w}</li>)}
    </ul>}
  </section>;
}

export function ReinforcementPanel({ rl }: { rl?: ReinforcementEvaluation }) {
  if (!rl) return <section className="panel mt-5 p-4 sm:p-5" data-testid="panel-reinforcement">
    <p className="eyebrow">06 / Policy evaluation</p><h2 className="display mt-1 text-[20px] font-semibold">Reinforcement-learning policy</h2>
    <p className="mt-3 border border-dashed border-[#dedbd1] p-4 text-xs text-[#838a82]" data-testid="status-rl-unavailable">This run predates RL evaluation or did not report one. Nothing is inferred.</p>
  </section>;
  const ready = rl.status === 'ready';
  const actionTone = rl.selectedAction === 'long' ? 'text-[#2d8068]' : rl.selectedAction === 'short' ? 'text-[#b45f49]' : 'text-[#25313c]';
  return <section className="panel mt-5 p-4 sm:p-5" data-testid="panel-reinforcement">
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div><p className="eyebrow">06 / Policy evaluation</p><h2 className="display mt-1 text-[20px] font-semibold">Reinforcement-learning policy</h2></div>
      <span data-testid="status-rl" className={`mono rounded-sm px-2 py-1 text-[9px] uppercase tracking-wider ${ready ? 'bg-[#e7eee8] text-[#39725e]' : 'bg-[#f6eee3] text-[#8f513c]'}`}>{ready ? 'Evaluated' : 'Insufficient data'}</span>
    </div>
    <div className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-[minmax(0,.9fr)_minmax(0,1.1fr)]">
      <div className="space-y-3 text-xs leading-5">
        <p><span className="eyebrow mr-2">Method</span><span data-testid="text-rl-method">{rl.method}</span></p>
        <p className={ready ? 'text-[#69736e]' : 'border-l-2 border-[#c56b50] pl-3 text-[#8f513c]'} data-testid="text-rl-reason">{rl.reason}</p>
        <div className="mono grid grid-cols-2 gap-3 text-[10px] text-[#59665d] sm:grid-cols-4">
          <div><span className="eyebrow block">Episodes</span><b data-testid="text-rl-episodes">{rl.episodes.toLocaleString()}</b></div>
          <div><span className="eyebrow block">Folds</span><b data-testid="text-rl-folds">{rl.folds}</b></div>
          <div><span className="eyebrow block">OOS sessions</span><b data-testid="text-rl-sample">{rl.sampleSize.toLocaleString()}</b></div>
          <div><span className="eyebrow block">Seeds</span><b data-testid="text-rl-seeds">{rl.seeds.length ? rl.seeds.join(', ') : '—'}</b></div>
        </div>
        <p className="mono text-[10px] text-[#788078]" data-testid="text-rl-window">OOS window: {rl.testStart?.slice(0, 10) ?? '—'} to {rl.testEnd?.slice(0, 10) ?? '—'}</p>
      </div>
      <div className="border border-[#dedbd1] bg-[#f7f5ef] p-4" data-testid="card-rl-next-action">
        <p className="eyebrow">Policy position for the next session</p>
        <p className={`display mt-2 text-[30px] font-semibold uppercase leading-none ${actionTone}`} data-testid="text-rl-selected-action">{ready && rl.selectedAction ? rl.selectedAction : 'None'}</p>
        <p className="mt-2 text-[11px] leading-5 text-[#69736e]">{ready && rl.selectedAction ? 'Applies to execution at the next trading session after the latest observed close — not to a session already observed.' : 'No action is reported when evaluation is insufficient.'}</p>
        <p className="mt-2 text-[11px] text-[#69736e]" data-testid="text-rl-beats-buyhold">Versus buy-and-hold (net, OOS): {rl.beatsBuyHold == null ? 'not reported' : rl.beatsBuyHold ? 'outperformed in this sample' : 'did not outperform'}. Not evidence of future profitability.</p>
        <p className="mt-2 border-t border-[#e5e2d9] pt-2 text-[10px] leading-4 text-[#788078]" data-testid="text-rl-execution"><b>Execution:</b> {rl.execution}</p>
      </div>
    </div>
    {ready && <div className="mt-5 grid min-w-0 grid-cols-1 gap-5 [&>div]:min-w-0">
      <StatsTable title="Ensemble vs benchmarks (out-of-sample)" prefix="rl-benchmark" lead={{ name: 'RL ensemble', metrics: rl.metrics ?? { sharpe: null, sortino: null, maxDrawdown: null, grossTotalReturn: null, netTotalReturn: null } }} rows={rl.benchmarks ?? []} />
      <StatsTable title="Per-seed results" prefix="rl-seed" rows={rl.seedResults ?? []} />
      <div>
        <p className="eyebrow mb-2">Walk-forward fold windows</p>
        {rl.foldWindows?.length ? <div className="scrollbar-thin overflow-x-auto"><table className="w-full min-w-[420px] text-left text-xs">
          <thead><tr className="border-b border-[#dedbd1] text-[9px] uppercase tracking-wider text-[#838b84]"><th className="pb-2 font-medium">Fold</th><th className="pb-2 font-medium">Train end</th><th className="pb-2 font-medium">Test start</th><th className="pb-2 font-medium">Test end</th></tr></thead>
          <tbody>{rl.foldWindows.map((f, i) => <tr key={i} data-testid={`row-rl-fold-${i}`} className="mono border-b border-[#ebe9e1] last:border-0"><td className="py-2">{i + 1}</td><td>{f.trainEnd.slice(0, 10)}</td><td>{f.testStart.slice(0, 10)}</td><td>{f.testEnd.slice(0, 10)}</td></tr>)}</tbody>
        </table></div> : <p className="text-[11px] text-[#838a82]">Fold windows not reported.</p>}
      </div>
    </div>}
    {rl.limitations.length > 0 && <div className="mt-5 border-t border-[#e5e2d9] pt-3" data-testid="list-rl-limitations">
      <p className="eyebrow mb-2">Limitations</p>
      <ul className="space-y-1 text-[11px] leading-5 text-[#69736e]">{rl.limitations.map((l, i) => <li key={i} data-testid={`text-rl-limitation-${i}`} className="flex gap-2"><span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-[#8f9d98]" />{l}</li>)}</ul>
    </div>}
  </section>;
}

function download(content: string, type: string, name: string) {
  const href = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a'); a.href = href; a.download = name; a.click();
  URL.revokeObjectURL(href);
}

export function OutlookPanel({ dashboard, isHistoricalSelection }: { dashboard: ForecastDashboard; isHistoricalSelection: boolean }) {
  const { outlookHtml, outlookMarkdown } = dashboard;
  if (!outlookHtml && !outlookMarkdown) return null;
  const base = `${dashboard.assetSymbol.toLowerCase()}-outlook${dashboard.historicalAsOf ? `-${dashboard.historicalAsOf}` : ''}`;
  const stale = Boolean(dashboard.historicalAsOf) || isHistoricalSelection;
  return <section className="panel mt-5 flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5" data-testid="panel-outlook">
    <div className="flex gap-3">
      <FileText size={18} className="mt-1 shrink-0 text-[#7f8981]" />
      <div>
        <p className="eyebrow">One-page outlook · printable A4</p>
        <p className="mt-1 text-xs leading-5 text-[#69736e]" data-testid="text-outlook-label">
          {stale ? <strong className="text-[#8f513c]">Historical outlook{dashboard.historicalAsOf ? ` as of ${dashboard.historicalAsOf}` : ' from a saved run'} — may be stale; not a current signal.</strong> : `Generated from data last updated ${dashboard.lastUpdated ? new Date(dashboard.lastUpdated).toLocaleString() : 'at an unknown time'}.`}
        </p>
      </div>
    </div>
    <div className="flex flex-wrap gap-2">
      {outlookHtml && <button type="button" onClick={() => download(outlookHtml, 'text/html;charset=utf-8', `${base}.html`)} data-testid="button-download-outlook-html" className="flex h-9 items-center gap-2 bg-[#2d8068] px-3 text-xs font-semibold text-white hover:bg-[#246b57]"><ArrowDownToLine size={14} /> HTML (A4)</button>}
      {outlookMarkdown && <button type="button" onClick={() => download(outlookMarkdown, 'text/markdown;charset=utf-8', `${base}.md`)} data-testid="button-download-outlook-md" className="flex h-9 items-center gap-2 border border-[#c8c5bb] px-3 text-xs font-semibold hover:bg-white"><ArrowDownToLine size={14} /> Markdown</button>}
    </div>
  </section>;
}
