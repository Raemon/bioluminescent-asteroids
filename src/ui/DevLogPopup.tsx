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

export const DevLogPopup = () => {
  const [entry, setEntry] = useState<DevLogEntry | null>(null);
  const [open, setOpen] = useState(false);
  const [visible, setVisible] = useState(false);

  const close = () => {
    setVisible(false);
    window.setTimeout(() => setOpen(false), 300);
  };

  useEffect(() => {
    let cancelled = false;
    fetch("/devlog.json", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled) return;
        if (!Array.isArray(data) || data.length === 0) return;
        const newest = data[0] as DevLogEntry;
        if (!newest?.id || !newest?.title || !Array.isArray(newest?.sections)) return;
        setEntry(newest);
        const seen = readSeen() === newest.id;
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
    const onToggle = () => {
      if (!entry) return;
      if (open) {
        close();
      } else {
        setOpen(true);
        window.setTimeout(() => setVisible(true), 32);
        writeSeen(entry.id);
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
  }, [entry, open]);

  if (!entry || !open) return null;

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
      <button type="button" className="devlog-popup__dismiss" onClick={close}>
        Close
      </button>
    </div>
  );
};
