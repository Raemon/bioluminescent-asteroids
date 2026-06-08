import { useEffect, useState } from "react";

type DevLogSection = { heading: string; items: string[] };
type DevLogEntry = {
  id: string;
  date: string;
  title: string;
  sections: DevLogSection[];
};

const STORAGE_KEY = "pulsar:devlog:lastSeenId";

const readSeen = (): string | null => {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
};

const writeSeen = (id: string) => {
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // localStorage unavailable — unseen indicator just persists.
  }
};

const isValidEntry = (e: unknown): e is DevLogEntry => {
  const entry = e as DevLogEntry | null;
  return !!entry?.id && !!entry?.title && Array.isArray(entry?.sections);
};

export const DevLogPopup = () => {
  const [entries, setEntries] = useState<DevLogEntry[]>([]);
  const [open, setOpen] = useState(false);
  const [visible, setVisible] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const close = () => {
    setVisible(false);
    window.setTimeout(() => setOpen(false), 300);
  };

  const toggleExpanded = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

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
        const seen = readSeen() === valid[0].id;
        window.dispatchEvent(
          new CustomEvent("devlog:unseen", { detail: { unseen: !seen } }),
        );
      })
      .catch(() => {
        // Missing or malformed devlog.json — silently skip.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const newest = entries[0];
    const onToggle = () => {
      if (!newest) return;
      if (open) {
        close();
      } else {
        setOpen(true);
        window.setTimeout(() => setVisible(true), 32);
        writeSeen(newest.id);
        window.dispatchEvent(
          new CustomEvent("devlog:unseen", { detail: { unseen: false } }),
        );
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && open) {
        e.stopPropagation();
        close();
      }
    };
    window.addEventListener("devlog:toggle", onToggle);
    document.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("devlog:toggle", onToggle);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [entries, open]);

  if (entries.length === 0 || !open) return null;

  return (
    <div
      className={`devlog-popup${visible ? " visible" : ""}`}
      role="dialog"
      aria-labelledby="devlog-title"
    >
      <button
        type="button"
        className="devlog-popup__close"
        aria-label="Close dev log"
        onClick={close}
      >
        ×
      </button>
      <div className="devlog-popup__eyebrow">Dev Log</div>
      <div className="devlog-popup__scroll">
        {entries.map((entry, idx) => {
          const isExpanded = expanded.has(entry.id);
          const headingId = idx === 0 ? "devlog-title" : undefined;
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
                  <span id={headingId} className="devlog-entry__title">
                    {entry.title}
                  </span>
                </span>
              </button>
              {isExpanded && (
                <div className="devlog-entry__body">
                  {entry.sections.map((section, i) => (
                    <section key={i} className="devlog-popup__section">
                      <h4 className="devlog-popup__heading">{section.heading}</h4>
                      <ul className="devlog-popup__list">
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
      <button type="button" className="devlog-popup__dismiss" onClick={close}>
        Close
      </button>
    </div>
  );
};
