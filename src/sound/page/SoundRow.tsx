import { useEffect, useRef } from "react";
import { ANIMATIONS, type Animator } from "./animations";
import { animationFor, sublabelFor, type Action, type GameObject } from "./sounds";

export type RowState = {
  // Animator-relative seconds when this row's sound last fired (-1 if never).
  lastFiredAtAnim: number;
  // Only meaningful for loop rows.
  loopActive: boolean;
};

export type RowApi = {
  object: GameObject;
  action: Action;
  state: RowState;
  isChecked: () => boolean;
  fire: () => void;
};

type Props = {
  object: GameObject;
  action: Action;
  showObjectLabel: boolean;
  checked: boolean;
  onToggle: (next: boolean) => void;
  // Registers a per-row API the parent's tick loop can read/drive.
  registerRow: (api: RowApi) => () => void;
};

export const SoundRow = ({ object, action, showObjectLabel, checked, onToggle, registerRow }: Props) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const elRef = useRef<HTMLDivElement | null>(null);
  const animatorRef = useRef<Animator | null>(null);
  const mountedAtRef = useRef<number>(performance.now());
  const stateRef = useRef<RowState>({ lastFiredAtAnim: -1, loopActive: false });
  const checkedRef = useRef(checked);
  checkedRef.current = checked;

  useEffect(() => {
    animatorRef.current = ANIMATIONS[animationFor(object, action)]();
    mountedAtRef.current = performance.now();

    const api: RowApi = {
      object,
      action,
      state: stateRef.current,
      isChecked: () => checkedRef.current,
      fire: () => {
        const el = elRef.current;
        stateRef.current.lastFiredAtAnim = (performance.now() - mountedAtRef.current) / 1000;
        if (el) {
          el.classList.add("se-firing");
          window.setTimeout(() => el.classList.remove("se-firing"), 160);
        }
      },
    };

    let rafId = 0;
    let lastFrameMs = performance.now();
    const tick = (nowMs: number) => {
      const dtMs = nowMs - lastFrameMs;
      lastFrameMs = nowMs;
      const dt = Math.min(0.05, dtMs / 1000);
      const canvas = canvasRef.current;
      const animator = animatorRef.current;
      if (canvas && animator) {
        const ctx = canvas.getContext("2d");
        if (ctx) {
          animator({
            ctx,
            w: canvas.width,
            h: canvas.height,
            t: (nowMs - mountedAtRef.current) / 1000,
            dt,
            playing: stateRef.current.loopActive,
            firedAt: stateRef.current.lastFiredAtAnim,
          });
        }
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);

    const unregister = registerRow(api);
    return () => {
      cancelAnimationFrame(rafId);
      unregister();
    };
  }, [object, action, registerRow]);

  return (
    <div
      ref={elRef}
      className={[
        "se-row group grid items-center gap-[14px] border-t border-white/30 py-[6px] transition-colors",
        "[grid-template-columns:200px_320px_auto]",
      ].join(" ")}
    >
      <div className="se-vis">
        <canvas
          ref={canvasRef}
          width={200}
          height={100}
          className="block py-[6px]h [100px] w-[200px] bg-[#02040a] transition-shadow"
        />
      </div>
      <div className="flex min-w-0 flex-col gap-[6px]">
        {showObjectLabel && (
          <div className="overflow-hidden text-ellipsis whitespace-nowrap text-[12px] uppercase tracking-[0.12em] text-[#6ad7ff]">
            {object.label}
          </div>
        )}
        <div className="overflow-hidden text-ellipsis whitespace-nowrap text-[11px] tracking-[0.05em] text-[rgba(214,236,255,0.9)]">
          {sublabelFor(action)}
        </div>
      </div>
      <label className="relative h-[20px] w-[20px] cursor-pointer select-none">
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onToggle(e.target.checked)}
          className="absolute inset-0 m-0 cursor-pointer opacity-0"
        />
        <span
          className={[
            "pointer-events-none absolute inset-0 rounded-full border-[1.5px] transition-[border-color,box-shadow,background]",
            checked
              ? "border-[#6ad7ff] bg-[rgba(106,215,255,0.18)] shadow-[0_0_14px_rgba(106,215,255,0.45)]"
              : "border-[rgba(106,215,255,0.35)] hover:border-[rgba(106,215,255,0.7)]",
          ].join(" ")}
        >
          {checked && (
            <span className="absolute inset-[5px] rounded-full bg-[#6ad7ff] shadow-[0_0_8px_#6ad7ff]" />
          )}
        </span>
      </label>
    </div>
  );
};
