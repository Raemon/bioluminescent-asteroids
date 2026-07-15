import { useEffect, useState } from "react";

type DevLogSection = { heading: string; items: string[] };
type DevLogEntry = {
  id: string;
  date: string;
  title: string;
  sections: DevLogSection[];
};

const SEEN_KEY = "pulsar:devlog:lastSeenId";
// Written by sessionTracker when a run starts — presence means a prior visit.
const RETURNING_KEY = "pulsar.lastRunStartAt.v1";

const readSeen = (): string | null => {
  try {
    return localStorage.getItem(SEEN_KEY);
  } catch {
    return null;
  }
};

const writeSeen = (id: string) => {
  try {
    localStorage.setItem(SEEN_KEY, id);
  } catch {
    // localStorage unavailable — teaser just reappears next visit.
  }
};

const hasVisitedBefore = (): boolean => {
  try {
    return localStorage.getItem(RETURNING_KEY) !== null;
  } catch {
    return false;
  }
};

const isValidEntry = (e: unknown): e is DevLogEntry => {
  const entry = e as DevLogEntry | null;
  return !!entry?.id && !!entry?.title && Array.isArray(entry?.sections);
};

type Mode = "collapsed" | "teaser" | "open";

// The top-left "Dev Log" button and the panel are the same element: the
// button morphs (width/max-height transition) between three states —
// collapsed label, slightly-expanded teaser of the newest entry for
// returning players, and the full entry list.
export const DevLog = () => {
  const [entries, setEntries] = useState<DevLogEntry[]>([]);
  const [mode, setMode] = useState<Mode>("collapsed");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // Shown only on the title screen — the same screens that show the leaderboard.
  const [onTitle, setOnTitle] = useState(false);

  const newest = entries[0];
  const isOpen = mode === "open";

  useEffect(() => {
    let cancelled = false;
    fetch("/devlog.json", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled) return;
        if (!Array.isArray(data) || data.length === 0) return;
        const valid = data.filter(isValidEntry);
        if (valid.length === 0) return;
        setEntries(valid);
        setExpanded(new Set([valid[0].id]));
        if (hasVisitedBefore() && readSeen() !== valid[0].id) {
          setMode("teaser");
        }
      })
      .catch(() => {
        // Missing or malformed devlog.json — silently skip.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setMode("collapsed");
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [isOpen]);

  // Track the title screen so the panel appears only there, and collapse it on
  //   leaving so returning to title shows it closed (or as a fresh teaser).
  useEffect(() => {
    const onState = (e: Event) => {
      const { state } = (e as CustomEvent<{ state: string }>).detail;
      const title = state === "title";
      setOnTitle(title);
      if (!title) setMode((m) => (m === "open" ? "collapsed" : m));
    };
    window.addEventListener("game:state", onState as EventListener);
    return () => window.removeEventListener("game:state", onState as EventListener);
  }, []);

  const open = () => {
    if (!newest) return;
    setMode("open");
    writeSeen(newest.id);
  };

  const close = () => setMode("collapsed");

  const toggleExpanded = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  if (!onTitle) return null;

  return (
    <div
      className={`devlog devlog--${mode}`}
      role={isOpen ? "dialog" : undefined}
      aria-labelledby={isOpen ? "devlog-title" : undefined}
    >
      {isOpen ? (
        <>
          <button
            type="button"
            className="devlog__close"
            aria-label="Close dev log"
            onClick={close}
          >
            ×
          </button>
          <div id="devlog-title" className="devlog__eyebrow">
            Dev Log
          </div>
          <div className="devlog__scroll">
            {entries.map((entry) => {
              const isExpanded = expanded.has(entry.id);
              return (
                <article
                  key={entry.id}
                  className={`devlog-entry${isExpanded ? " devlog-entry--expanded" : ""}`}
                >
                  <button
                    type="button"
                    className="devlog-entry__summary"
                    aria-expanded={isExpanded}
                    onClick={() => toggleExpanded(entry.id)}
                  >
                    <span className="devlog-entry__chevron" aria-hidden="true">
                      {isExpanded ? "▾" : "▸"}
                    </span>
                    <span className="devlog-entry__meta">
                      <span className="devlog-entry__date">{entry.date}</span>
                      <span className="devlog-entry__title">{entry.title}</span>
                    </span>
                  </button>
                  {isExpanded && (
                    <div className="devlog-entry__body">
                      {entry.sections.map((section, i) => (
                        <section key={i} className="devlog__section">
                          <h4 className="devlog__heading">{section.heading}</h4>
                          <ul className="devlog__list">
                            {section.items.map((item, j) => (
                              <li key={j}>{item}</li>
                            ))}
                          </ul>
                        </section>
                      ))}
                    </div>
                  )}
                </article>
              );
            })}
          </div>
          <button type="button" className="devlog__dismiss" onClick={close}>
            Close
          </button>
        </>
      ) : (
        <button
          type="button"
          className="devlog__opener"
          aria-expanded={false}
          onClick={open}
        >
          <span className="devlog__eyebrow">Dev Log</span>
          {mode === "teaser" && newest && (
            <>
              <span className="devlog__teaser-title">{newest.title}</span>
              <span className="devlog__learn-more">learn more</span>
            </>
          )}
        </button>
      )}
    </div>
  );
};
