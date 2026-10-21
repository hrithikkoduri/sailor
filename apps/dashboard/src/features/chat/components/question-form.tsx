import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, ArrowUpRight, Check, ChevronDown, ChevronUp, HelpCircle, Loader2, PenLine } from "lucide-react";
import { answerQuestions, type QuestionRequest } from "@/features/threads/api";
import { Button } from "@/elements/button";
import { IconButton } from "@/elements/icon-button";
import { useThreadTabs } from "@/features/thread-tabs/thread-tabs-provider";
import { cn } from "@/utils/cn";

type Answers = Record<string, string | string[]>;
type Question = QuestionRequest["questions"][number];
const OTHER = "__other";
/** A drag shorter than this still counts as a tap (selection, scrolling). */
const SWIPE_THRESHOLD = 56;

export function QuestionForm({
  request,
  paused,
  onAnswered,
  overlay = false,
}: {
  request: QuestionRequest;
  paused: boolean;
  onAnswered: () => void;
  /** Floating above the composer instead of inline in the transcript. */
  overlay?: boolean;
}) {
  const { getFormDraft, saveFormDraft } = useThreadTabs();
  const [answers, setAnswers] = useState<Answers>(() => request.answers ?? getFormDraft(request.id) ?? {});
  // Which choice questions are answering with free text ("Something else").
  const [other, setOther] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [index, setIndex] = useState(0);
  const [collapsed, setCollapsed] = useState(false);
  const answered = request.status === "answered" || submitted;
  const questions = request.questions;
  const many = questions.length > 1;
  const current = Math.min(index, questions.length - 1);
  const drag = useRef<{ x: number; y: number; id: number } | null>(null);

  useEffect(() => {
    saveFormDraft(request.id, answered ? null : answers);
  }, [request.id, answered, answers, saveFormDraft]);

  const go = useCallback(
    (next: number) => setIndex(Math.max(0, Math.min(questions.length - 1, next))),
    [questions.length],
  );

  const submit = async () => {
    if (busy || answered) return;
    // Free-text choices travel as ordinary answers: one custom value is
    // accepted by the server for any choice question.
    const payload: Answers = { ...answers };
    for (const [qid, text] of Object.entries(other)) {
      if (!text.trim()) continue;
      const multi = Array.isArray(payload[qid]);
      payload[qid] = multi ? [...(payload[qid] as string[]), text.trim()] : text.trim();
    }
    setBusy(true);
    setError("");
    try {
      await answerQuestions(request.id, payload);
      setSubmitted(true);
      onAnswered();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Answers couldn't be submitted.");
    } finally {
      setBusy(false);
    }
  };

  const renderQuestion = (q: Question) => {
    const id = `${request.id}-${q.id}`;
    const custom = other[q.id];
    const isOther = custom !== undefined;
    const selectedText = typeof answers[q.id] === "string" ? (answers[q.id] as string) : "";
    const selectedList = Array.isArray(answers[q.id]) ? (answers[q.id] as string[]) : [];
    const isPreset = q.options?.some((o) => o.value === selectedText);
    if (q.type === "text")
      return (
        <>
          <label htmlFor={id} className="block text-sm font-medium">
            {q.label}
            {!q.required && <span className="ml-2 text-xs font-normal text-muted-foreground">Optional</span>}
          </label>
          {q.description && (
            <p id={`${id}-hint`} className="mt-1 text-xs leading-relaxed text-muted-foreground">
              {q.description}
            </p>
          )}
          <textarea
            id={id}
            rows={3}
            required={q.required}
            maxLength={8000}
            aria-describedby={q.description ? `${id}-hint` : undefined}
            value={selectedText}
            onChange={(event) => setAnswers((a) => ({ ...a, [q.id]: event.target.value }))}
            className="mt-3 block w-full resize-y rounded-lg border border-input bg-background px-3 py-2 text-sm"
          />
        </>
      );
    return (
      <fieldset>
        <legend className="text-sm font-medium">
          {q.label}
          {!q.required && <span className="ml-2 text-xs font-normal text-muted-foreground">Optional</span>}
        </legend>
        {q.description && <p className="mt-1 text-xs text-muted-foreground">{q.description}</p>}
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {q.options?.map((option) => {
            const selected =
              q.type === "multi_select" ? selectedList.includes(option.value) : selectedText === option.value && !isOther;
            return (
              <label
                key={option.value}
                className={`flex min-h-12 cursor-pointer items-center gap-3 rounded-lg border px-3 py-3 text-sm transition-colors ${selected ? "border-ring bg-selection" : "border-border hover:bg-muted/40"}`}
              >
                <input
                  type={q.type === "multi_select" ? "checkbox" : "radio"}
                  name={id}
                  value={option.value}
                  checked={selected}
                  required={q.required && q.type !== "multi_select"}
                  className="size-4 accent-[var(--primary)]"
                  onChange={() => {
                    setOther((o) => {
                      if (!(q.id in o)) return o;
                      const next = { ...o };
                      delete next[q.id];
                      return next;
                    });
                    setAnswers((a) => ({
                      ...a,
                      [q.id]:
                        q.type === "multi_select"
                          ? selected
                            ? selectedList.filter((v) => v !== option.value)
                            : [...selectedList, option.value]
                          : option.value,
                    }));
                  }}
                />
                <span className="min-w-0 break-words">
                  {option.label}
                  {q.recommended === option.value && (
                    <span className="mt-0.5 block text-[11px] text-muted-foreground">Suggested by Sailor</span>
                  )}
                </span>
              </label>
            );
          })}
          {/* Always offered last: a free-text answer the model did not anticipate. */}
          <label
            className={`flex min-h-12 cursor-pointer items-center gap-3 rounded-lg border px-3 py-3 text-sm transition-colors ${isOther ? "border-ring bg-selection" : "border-border hover:bg-muted/40"}`}
          >
            <input
              type={q.type === "multi_select" ? "checkbox" : "radio"}
              name={id}
              value={OTHER}
              checked={isOther}
              required={q.required && q.type !== "multi_select" && !selectedText}
              className="size-4 accent-[var(--primary)]"
              onChange={() => {
                setOther((o) => {
                  const next = { ...o };
                  if (q.id in next) delete next[q.id];
                  else next[q.id] = "";
                  return next;
                });
                if (q.type !== "multi_select") setAnswers((a) => ({ ...a, [q.id]: "" }));
              }}
            />
            <span className="flex min-w-0 items-center gap-2 break-words">
              <PenLine className="size-3.5 shrink-0 text-muted-foreground" />
              Something else…
            </span>
          </label>
        </div>
        {isOther && (
          <div className="mt-3">
            <label htmlFor={`${id}-other`} className="sr-only">
              Your answer for {q.label}
            </label>
            <textarea
              id={`${id}-other`}
              rows={2}
              autoFocus
              required
              maxLength={2000}
              placeholder="Tell Sailor what you want instead…"
              value={custom}
              onChange={(event) => setOther((o) => ({ ...o, [q.id]: event.target.value }))}
              className="block w-full resize-y rounded-lg border border-input bg-background px-3 py-2 text-sm"
            />
          </div>
        )}
        {!isOther && q.type === "single_select" && selectedText && !isPreset && (
          <p className="mt-2 text-xs text-muted-foreground">Free-text answer: {selectedText}</p>
        )}
      </fieldset>
    );
  };

  const answeredCount = questions.filter((q) => {
    const value = answers[q.id];
    return Array.isArray(value) ? value.length > 0 : typeof value === "string" && value.trim().length > 0;
  }).length;

  // Collapsed: a slim bar above the composer that still says work is blocked.
  if (overlay && collapsed && !answered)
    return (
      <button
        type="button"
        aria-expanded={false}
        aria-controls={`${request.id}-form`}
        onClick={() => setCollapsed(false)}
        className="flex w-full items-center gap-3 rounded-xl border border-input bg-card px-4 py-2.5 text-left shadow-[0_-6px_24px_-16px_#0003] transition-colors hover:bg-muted/40"
      >
        <span className="flex size-7 shrink-0 items-center justify-center rounded-lg border border-border bg-background">
          <HelpCircle className="size-3.5 text-muted-foreground" />
        </span>
        <span className="min-w-0 flex-1 truncate text-xs">
          <span className="font-medium">
            Needs answers for {questions.length} {questions.length === 1 ? "question" : "questions"}
          </span>
          <span className="text-muted-foreground">
            {" · "}
            {answeredCount}/{questions.length} answered
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs font-medium">
          <ChevronUp className="size-3.5" />
          Answer
        </span>
      </button>
    );

  return (
    <form
      id={`${request.id}-form`}
      aria-label={request.title}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      className={
        overlay
          ? "flex max-h-[62vh] flex-col overflow-hidden rounded-2xl border border-input bg-card shadow-[0_-8px_40px_-18px_#0004]"
          : "my-7 overflow-hidden rounded-2xl border border-input bg-card shadow-[0_6px_30px_-22px_#0003]"
      }
    >
      <div className="flex shrink-0 items-start gap-3 border-b border-border bg-muted/20 px-5 py-4">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border bg-card">
          {answered ? <Check className="size-4 text-success" /> : <HelpCircle className="size-4 text-muted-foreground" />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="eyebrow mb-1">{answered ? "Answers sent" : "A little direction"}</p>
          <h3 className="text-sm font-medium">{request.title}</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {answered
              ? "Sailor will continue with your answers."
              : many
                ? `Question ${current + 1} of ${questions.length} · swipe or use the arrows`
                : "Work is paused here. Your answers stay in the conversation."}
          </p>
        </div>
        {overlay && !answered && (
          <IconButton
            label="Collapse questions"
            aria-expanded
            aria-controls={`${request.id}-form`}
            onClick={() => setCollapsed(true)}
            className="shrink-0"
          >
            <ChevronDown />
          </IconButton>
        )}
      </div>
      <fieldset
        disabled={busy || answered || !paused}
        className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain p-5 pb-6 disabled:opacity-75"
        aria-roledescription={many ? "carousel" : undefined}
        onKeyDown={(event) => {
          if (!many) return;
          if (event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLInputElement) return;
          if (event.key === "ArrowRight") go(current + 1);
          if (event.key === "ArrowLeft") go(current - 1);
        }}
      >
        {many ? (
          <div
            className="overflow-hidden"
            onPointerDown={(event) => {
              if ((event.target as HTMLElement).closest("textarea,input,button,a")) return;
              drag.current = { x: event.clientX, y: event.clientY, id: event.pointerId };
            }}
            onPointerUp={(event) => {
              const start = drag.current;
              drag.current = null;
              if (!start || start.id !== event.pointerId) return;
              const dx = event.clientX - start.x;
              const dy = event.clientY - start.y;
              if (Math.abs(dx) < SWIPE_THRESHOLD || Math.abs(dx) < Math.abs(dy)) return;
              go(current + (dx < 0 ? 1 : -1));
            }}
            onPointerCancel={() => {
              drag.current = null;
            }}
          >
            <div
              className="flex transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none"
              style={{
                width: `${questions.length * 100}%`,
                transform: `translateX(-${(current * 100) / questions.length}%)`,
              }}
            >
              {questions.map((q, i) => (
                <div
                  key={q.id}
                  role="group"
                  aria-roledescription="slide"
                  aria-label={`Question ${i + 1} of ${questions.length}`}
                  aria-hidden={i !== current || undefined}
                  inert={i !== current || undefined}
                  className="min-w-0 shrink-0 px-0.5"
                  style={{ width: `${100 / questions.length}%` }}
                >
                  {renderQuestion(q)}
                </div>
              ))}
            </div>
          </div>
        ) : (
          renderQuestion(questions[0]!)
        )}
      </fieldset>
      {!answered && (
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-border px-5 py-3">
          {many ? (
            <div className="flex items-center gap-2">
              <IconButton label="Previous question" onClick={() => go(current - 1)} disabled={current === 0}>
                <ArrowLeft />
              </IconButton>
              <div className="flex items-center gap-1.5" role="tablist" aria-label="Questions">
                {questions.map((q, i) => (
                  <button
                    key={q.id}
                    type="button"
                    role="tab"
                    aria-selected={i === current}
                    aria-label={`Question ${i + 1}${answers[q.id] ? " (answered)" : ""}`}
                    onClick={() => go(i)}
                    className={cn(
                      "h-1.5 rounded-full transition-all",
                      i === current ? "w-5 bg-foreground" : "w-1.5 bg-muted-foreground/40 hover:bg-muted-foreground/70",
                      answers[q.id] && i !== current && "bg-success/70",
                    )}
                  />
                ))}
              </div>
              <IconButton label="Next question" onClick={() => go(current + 1)} disabled={current === questions.length - 1}>
                <ArrowRight />
              </IconButton>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              {paused ? "One answer, then back to work." : "Sailor is finishing the current step…"}
            </p>
          )}
          <Button type="submit" disabled={busy || !paused}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <ArrowUpRight className="size-4" />}
            Submit answers
          </Button>
        </div>
      )}
      {error && (
        <p role="alert" className="shrink-0 border-t border-border px-5 py-3 text-sm text-destructive">
          {error}
        </p>
      )}
    </form>
  );
}
