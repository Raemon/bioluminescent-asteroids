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
    // localStorage unavailable — popup will just re-show next visit.
  }
};

export const DevLogPopup = () => {
  const [entry, setEntry] = useState<DevLogEntry | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/devlog.json", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled) return;
        if (!Array.isArray(data) || data.length === 0) return;
        const newest = data[0] as DevLogEntry;
        if (!newest?.id || !newest?.title || !Array.isArray(newest?.sections)) return;
        if (readSeen() === newest.id) return;
        setEntry(newest);
        // Tiny delay so the CSS transition runs from initial state.
        window.setTimeout(() => setVisible(true), 32);
      })
      .catch(() => {
        // Missing or malformed devlog.json — silently skip.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!entry) return null;

  const dismiss = () => {
    writeSeen(entry.id);
    setVisible(false);
    window.setTimeout(() => setEntry(null), 300);
  };

  return (
    <div
      className={`devlog-popup${visible ? " visible" : ""}`}
      role="dialog"
      aria-labelledby="devlog-title"
    >
      <button
        type="button"
        className="devlog-popup__close"
        aria-label="Dismiss dev log"
        onClick={dismiss}
      >
        ×
      </button>
      <div className="devlog-popup__eyebrow">Dev Log · {entry.date}</div>
      <h3 id="devlog-title" className="devlog-popup__title">{entry.title}</h3>
      <div className="devlog-popup__scroll">
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
      <button type="button" className="devlog-popup__dismiss" onClick={dismiss}>
        Got it
      </button>
    </div>
  );
};
