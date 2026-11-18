import { CheckCircle2, ChartNoAxesColumnIncreasing } from "lucide-react";

type SharedOption = { label: string; count: number };
type SharedRow = { id: string; title: string; responseCount: number; options: SharedOption[] };

function safeCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100000, Math.trunc(value)));
}

function parseRows(value: unknown): SharedRow[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 40).flatMap((entry, index) => {
    if (!entry || typeof entry !== "object") return [];
    const row = entry as Record<string, unknown>;
    const options = Array.isArray(row.options) ? row.options.slice(0, 30).flatMap((option) => {
      if (!option || typeof option !== "object") return [];
      const item = option as Record<string, unknown>;
      if (typeof item.label !== "string") return [];
      return [{ label: item.label.slice(0, 160), count: safeCount(item.count) }];
    }) : [];
    return [{
      id: typeof row.slideId === "string" ? row.slideId.slice(0, 80) : `shared-${index}`,
      title: typeof row.title === "string" && row.title.trim() ? row.title.slice(0, 160) : `Folie ${index + 1}`,
      responseCount: safeCount(row.responseCount),
      options,
    }];
  });
}

export default function SharedResultsView({ value }: { value: unknown }) {
  const rows = parseRows(value);
  return (
    <section className="shared-results" aria-live="polite" aria-label="Freigegebene Klassenergebnisse">
      <header className="shared-results-heading">
        <span className="shared-results-icon"><ChartNoAxesColumnIncreasing size={19} aria-hidden="true" /></span>
        <div><strong>Gemeinsame Ergebnisse</strong><p>Von deiner Lehrkraft freigegebene Klassenübersicht.</p></div>
      </header>
      {rows.length === 0 ? (
        <div className="shared-results-empty"><CheckCircle2 size={19} aria-hidden="true" /><span>Die Lehrkraft hat noch keine Ergebnisse geteilt.</span></div>
      ) : (
        <div className="shared-results-list">
          {rows.map((row) => (
            <article className="shared-result-card" key={row.id}>
              <div className="shared-result-title"><strong>{row.title}</strong><span>{row.responseCount} {row.responseCount === 1 ? "Antwort" : "Antworten"}</span></div>
              {row.options.length > 0 ? (
                <div className="shared-result-options">
                  {row.options.map((option, index) => {
                    const percent = row.responseCount ? Math.min(100, Math.round(option.count / row.responseCount * 100)) : 0;
                    return (
                      <div className="shared-result-option" key={`${index}-${option.label}`}>
                        <div className="shared-result-label"><span>{option.label}</span><strong>{option.count}</strong></div>
                        <div className="shared-result-track" aria-label={`${option.label}: ${option.count} Antworten`}><span style={{ width: `${percent}%` }} /></div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="shared-result-summary">Die Klasse hat Beiträge zu diesem Thema eingereicht.</p>
              )}
            </article>
          ))}
        </div>
      )}
      <p className="shared-results-privacy">Geteilt werden nur zusammengefasste Zahlen – keine Namen und keine individuellen Antworten.</p>
    </section>
  );
}
