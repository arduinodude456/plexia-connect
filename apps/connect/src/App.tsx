import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  CircleHelp,
  Cloud,
  ImagePlus,
  Lightbulb,
  LoaderCircle,
  LockKeyhole,
  MessageCircle,
  Radio,
  Send,
  ShieldCheck,
  Sparkles,
  UsersRound,
  Video,
  X,
} from "lucide-react";
import {
  hasSupabaseConfig,
  createSignedPresentationUrl,
  createSnapshotScheduler,
  resumeStudentSession,
  getStudentResponse,
  getSessionSyncSnapshot,
  getMyGroupAssignment,
  joinClassSession,
  subscribeToPresentation,
  subscribeToStudentSession,
  submitResponse,
  supabase,
  uploadStudentPhoto,
  type ClassSession,
  type PlexiaSlide,
  type Presentation,
  type SessionBundle,
  type SlideType,
} from "@plexia/shared";
import SharedResultsView from "./components/SharedResultsView";


const RESUME_KEY = "plexia.connect.resume.v1";
interface ResumeEntry { sessionId: string; userId: string; joinCode: string }
interface StudentDraft {
  answer: string; selected: string[]; ideas: string[]; ideaDraft: string;
  photo: File | null; uploadedPhoto: { file: File; path: string } | null; dirty: boolean;
}
function readResumeEntry(): ResumeEntry | null {
  try {
    const entry = JSON.parse(sessionStorage.getItem(RESUME_KEY) || "null") as ResumeEntry | null;
    return entry && typeof entry.sessionId === "string" && typeof entry.userId === "string" && typeof entry.joinCode === "string" ? entry : null;
  } catch { return null; }
}
function storeResumeEntry(entry: ResumeEntry | null) {
  try { if (entry) sessionStorage.setItem(RESUME_KEY, JSON.stringify(entry)); else sessionStorage.removeItem(RESUME_KEY); }
  catch { /* Storage can be disabled; live participation remains available. */ }
}

const MAX_ANSWER_LENGTH = 2000;
const MAX_NICKNAME_LENGTH = 24;

const demoPresentation: Presentation = {
  id: "connect-demo",
  title: "Vom Samenkorn zur Pflanze",
  description: "Eine kleine Beispielaufgabe zum Ausprobieren.",
  theme: "light",
  version: 1,
  updatedAt: "",
  slides: [
    {
      id: "connect-demo-question",
      type: "multiple_choice",
      title: "Was braucht eine Pflanze zum Wachsen?",
      content: {
        question: "Welche Antwort passt am besten?",
        options: ["Licht, Wasser und Luft", "Nur Sand", "Dunkelheit und Salz"],
        allowMultiple: false,
      },
      elements: [],
      background: "#ffffff",
      createdAt: "",
    },
  ],
};

function errorMessage(error: unknown): string {
  const record = error && typeof error === "object" ? error as { message?: unknown; code?: unknown } : null;
  const message = typeof record?.message === "string" ? record.message : "";
  const code = typeof record?.code === "string" ? record.code : "";
  if (code === "anonymous_provider_disabled" || /anonymous.*(?:disabled|not enabled)|(?:disabled|not enabled).*anonymous/i.test(message)) {
    return "Die anonyme Schüleranmeldung ist noch nicht freigeschaltet. Bitte wende dich an deine Lehrkraft.";
  }
  if (code === "42501" || code === "PGRST301") {
    return "Der Zugriff wurde abgelehnt. Prüfe, ob du noch teilnimmst und die aktuelle Folie freigegeben ist.";
  }
  if (code === "PGRST116" || /not found|nicht gefunden|ended|beendet/i.test(message)) {
    return "Die Stunde oder Teilnahme ist nicht mehr verfügbar. Bitte prüfe den Code bei deiner Lehrkraft.";
  }
  if (/network|fetch|offline|failed to/i.test(message)) {
    return "Die Verbindung hat gerade nicht geklappt. Prüfe dein Internet und versuche es noch einmal.";
  }
  return message || "Das hat gerade nicht geklappt. Bitte versuche es noch einmal.";
}

function contentText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function stripStudentPrivateFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripStudentPrivateFields);
  if (!value || typeof value !== "object") return value;
  const privateFields = new Set(["correctIndex", "correct_index", "answerKey", "answer_key", "explanation"]);
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !privateFields.has(key))
    .map(([key, child]) => [key, stripStudentPrivateFields(child)]));
}

function sanitizeStudentPresentation(presentation: Presentation): Presentation {
  const clean = stripStudentPrivateFields(presentation) as Record<string, unknown>;
  delete clean.ownerId;
  return clean as unknown as Presentation;
}

function displayStatus(session: ClassSession): { label: string; tone: "live" | "paused" | "ended" } {
  if (session.status === "ended" || session.activityStatus === "ended") return { label: "Stunde beendet", tone: "ended" };
  if (session.status === "paused" || session.activityStatus === "paused") return { label: "Stunde pausiert", tone: "paused" };
  if (session.activityStatus !== "running") return { label: "Warte auf Start", tone: "paused" };
  return { label: "Stunde läuft", tone: "live" };
}

function sessionIsUnavailable(session: ClassSession): boolean {
  return session.status !== "live" || session.activityStatus !== "running";
}

function App() {
  const queryCode = useMemo(() => new URLSearchParams(window.location.search).get("code") ?? "", []);
  const [joinCode, setJoinCode] = useState(queryCode.toUpperCase().slice(0, 12));
  const [nickname, setNickname] = useState("");
  const [bundle, setBundle] = useState<SessionBundle | null>(null);
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState("");
  const [sessionError, setSessionError] = useState("");
  const [syncError, setSyncError] = useState("");
  const [syncHealthy, setSyncHealthy] = useState(false);
  const refreshSession = useRef<() => void>(() => {});
  const [resumeEntry, setResumeEntry] = useState<ResumeEntry | null>(() => {
    const entry = readResumeEntry();
    return queryCode && entry && entry.joinCode !== queryCode.trim().toUpperCase() ? null : entry;
  });
  const [resumeAttempt, setResumeAttempt] = useState(0);
  const [resuming, setResuming] = useState(false);
  const [resumeError, setResumeError] = useState("");
  const [sentNotice, setSentNotice] = useState("");
  const [demoChoice, setDemoChoice] = useState("");
  const [demoAnswered, setDemoAnswered] = useState(false);

  useEffect(() => {
    if (!resumeEntry || !hasSupabaseConfig) return;
    let active = true;
    setResuming(true);
    setResumeError("");
    void resumeStudentSession(resumeEntry.sessionId, resumeEntry.userId).then((restored) => {
      if (!active) return;
      if (restored.session.status === "ended" || !restored.presentation) {
        setResumeError("Diese Stunde ist beendet. Du kannst zur Startseite zurückkehren.");
        return;
      }
      setNickname(restored.nickname);
      setBundle({ session: restored.session, presentation: sanitizeStudentPresentation(restored.presentation) });
      setResumeEntry(null);
    }).catch((error: unknown) => {
      if (active) setResumeError(errorMessage(error));
    }).finally(() => { if (active) setResuming(false); });
    return () => { active = false; };
  }, [resumeEntry, resumeAttempt]);

  useEffect(() => {
    if (!bundle || !supabase) return;
    let active = true;
    let presentationVersion = "";
    let sessionStatus = "CONNECTING";
    let presentationStatus = "CONNECTING";
    let syncFailure = "";
    const showConnection = () => {
      if (!active) return;
      if (!navigator.onLine) setSyncError("Du bist offline. Deine Eingaben bleiben hier; nach der Wiederverbindung wird die Stunde abgeglichen.");
      else if (syncFailure) setSyncError(syncFailure);
      else if ([sessionStatus, presentationStatus].some((status) => ["CHANNEL_ERROR", "TIMED_OUT", "CLOSED"].includes(status))) {
        setSyncError("Die Live-Verbindung ist unterbrochen. Der regelmäßige Abgleich läuft weiter.");
      } else setSyncError("");
    };
    const scheduler = createSnapshotScheduler(async (isCurrent) => {
      try {
        const snapshot = await getSessionSyncSnapshot(bundle.session.id, bundle.session.presentationId, presentationVersion);
        if (!isCurrent()) return;
        if (snapshot.presentation) presentationVersion = snapshot.presentationVersion;
        setBundle((current) => {
          if (!current || current.session.id !== snapshot.session.id) return current;
          return { ...current, session: snapshot.session, presentation: snapshot.presentation ? sanitizeStudentPresentation(snapshot.presentation) : current.presentation };
        });
        syncFailure = "";
        setSyncHealthy(navigator.onLine);
        showConnection();
      } catch {
        if (!isCurrent()) return;
        syncFailure = "Der aktuelle Stundenstand konnte nicht abgeglichen werden. Bitte prüfe deine Verbindung; Connect versucht es erneut.";
        setSyncHealthy(false);
        showConnection();
      }
    });
    const invalidate = () => { if (active) { setSyncHealthy(false); scheduler.request(); } };
    refreshSession.current = invalidate;
    const statusChanged = (kind: "session" | "presentation", status: string) => {
      if (!active) return;
      if (kind === "session") sessionStatus = status; else presentationStatus = status;
      if (status === "SUBSCRIBED") invalidate();
      showConnection();
    };
    let channel: ReturnType<typeof subscribeToStudentSession> | null = null;
    let presentationChannel: ReturnType<typeof subscribeToPresentation> | null = null;
    try {
      channel = subscribeToStudentSession(bundle.session.id, invalidate, (status) => statusChanged("session", status));
      presentationChannel = subscribeToPresentation(bundle.session.presentationId, invalidate, (status) => statusChanged("presentation", status));
    } catch {
      sessionStatus = "CHANNEL_ERROR";
      showConnection();
    }
    const timer = window.setInterval(() => scheduler.request(false), 6000);
    const onResume = () => {
      if (!navigator.onLine) setSyncHealthy(false);
      else if (document.visibilityState === "visible") invalidate();
      showConnection();
    };
    window.addEventListener("online", onResume);
    window.addEventListener("offline", onResume);
    window.addEventListener("focus", onResume);
    document.addEventListener("visibilitychange", onResume);
    invalidate();
    return () => {
      active = false;
      scheduler.close();
      refreshSession.current = () => {};
      window.clearInterval(timer);
      window.removeEventListener("online", onResume);
      window.removeEventListener("offline", onResume);
      window.removeEventListener("focus", onResume);
      document.removeEventListener("visibilitychange", onResume);
      if (channel && supabase) void supabase.removeChannel(channel);
      if (presentationChannel && supabase) void supabase.removeChannel(presentationChannel);
    };
  }, [bundle?.session.id, bundle?.session.presentationId]);

  useEffect(() => {
    setSentNotice("");
  }, [bundle?.session.currentSlideIndex]);

  const handleJoin = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setJoinError("");
    setSessionError("");
    setSentNotice("");
    if (!hasSupabaseConfig) return;
    const cleanCode = joinCode.trim().toUpperCase();
    const cleanNickname = nickname.trim();
    if (!cleanCode) {
      setJoinError("Gib zuerst den Zugangscode deiner Lehrkraft ein.");
      return;
    }
    if (!cleanNickname) {
      setJoinError("Wähle einen Nickname, damit deine Lehrkraft deine Antwort zuordnen kann.");
      return;
    }
    setJoining(true);
    try {
      const joined = await joinClassSession(cleanCode, cleanNickname.slice(0, MAX_NICKNAME_LENGTH));
      const auth = await supabase?.auth.getSession();
      if (auth?.data.session?.user.is_anonymous) storeResumeEntry({ sessionId: joined.session.id, userId: auth.data.session.user.id, joinCode: cleanCode });
      setNickname(cleanNickname.slice(0, MAX_NICKNAME_LENGTH));
      setBundle({ ...joined, presentation: sanitizeStudentPresentation(joined.presentation) });
    } catch (error) {
      setJoinError(errorMessage(error));
    } finally {
      setJoining(false);
    }
  };

  const leaveSession = () => {
    storeResumeEntry(null);
    setResumeEntry(null);
    setSyncHealthy(false);
    setSyncError("");
    setBundle(null);
    setSessionError("");
    setSentNotice("");
  };


  if (resumeEntry) {
    return <main className="app-shell landing-shell"><section className="join-card" aria-live="polite">
      <h1>Teilnahme wiederherstellen</h1>
      <p>{resuming ? "Deine Stunde wird sicher wieder geladen …" : resumeError || "Die gespeicherte Teilnahme wird geprüft."}</p>
      {!resuming && <button className="button button-primary" type="button" onClick={() => setResumeAttempt((value) => value + 1)}>Erneut versuchen</button>}
      <button className="button button-secondary" type="button" onClick={leaveSession}>Zur Startseite</button>
    </section></main>;
  }

  if (bundle) {
    return (
      <main className="app-shell session-shell">
        <header className="topbar">
          <a className="brand" href={import.meta.env.BASE_URL} aria-label="PLEXIA Connect Startseite">
            <span className="brand-mark" aria-hidden="true"><span /><span /><span /></span>
            <span>PLEXIA <b>Connect</b></span>
          </a>
          <div className="private-pill"><LockKeyhole size={15} aria-hidden="true" /> Nur für diese Sitzung</div>
        </header>
        <SessionView
          bundle={bundle}
          nickname={nickname.trim().slice(0, MAX_NICKNAME_LENGTH)}
          sessionError={[syncError, sessionError].filter(Boolean).join(" ")}
          syncHealthy={syncHealthy}
          onRefresh={() => refreshSession.current()}
          sentNotice={sentNotice}
          onNotice={setSentNotice}
          onError={setSessionError}
          onLeave={leaveSession}
        />
        <footer className="site-footer">Dein Nickname wird nur verwendet, um deine Beiträge in dieser Stunde zuzuordnen.</footer>
      </main>
    );
  }

  return (
    <main className="app-shell landing-shell">
      <header className="topbar">
        <a className="brand" href={import.meta.env.BASE_URL} aria-label="PLEXIA Connect Startseite">
          <span className="brand-mark" aria-hidden="true"><span /><span /><span /></span>
          <span>PLEXIA <b>Connect</b></span>
        </a>
        <div className="private-pill"><LockKeyhole size={15} aria-hidden="true" /> Ohne Konto</div>
      </header>

      <section className="welcome-grid">
        <div className="welcome-copy">
          <span className="eyebrow"><Sparkles size={15} aria-hidden="true" /> MITMACHEN LEICHT GEMACHT</span>
          <h1>Deine Stunde.<br /><span>Deine Ideen.</span></h1>
          <p className="intro-copy">Mit dem Code deiner Lehrkraft bist du direkt dabei. Kein Konto, kein Passwort – nur du und deine Klasse.</p>
          <div className="privacy-note"><ShieldCheck size={19} aria-hidden="true" /><span><strong>Privat in dieser Sitzung.</strong> Wir fragen nur nach einem Nickname, damit deine Beiträge zugeordnet werden können.</span></div>
        </div>

        <section className="join-card" aria-labelledby="join-heading">
          {!hasSupabaseConfig && <DemoModeBanner />}
          <div className="card-icon"><Radio size={22} aria-hidden="true" /></div>
          <h2 id="join-heading">Bei einer Stunde mitmachen</h2>
          <p className="card-intro">Den Zugangscode findest du bei deiner Lehrkraft.</p>
          <form onSubmit={handleJoin} noValidate>
            <label className="field-label" htmlFor="join-code">Zugangscode</label>
            <input
              className="text-input code-input"
              id="join-code"
              name="join-code"
              autoComplete="off"
              autoCapitalize="characters"
              maxLength={12}
              placeholder="z. B. PFLANZE"
              value={joinCode}
              onChange={(event) => setJoinCode(event.target.value.toUpperCase().replace(/\s/g, ""))}
              aria-describedby="code-help"
              disabled={!hasSupabaseConfig || joining}
            />
            <span className="field-help" id="code-help">Buchstaben und Zahlen – Groß-/Kleinschreibung ist egal.</span>
            <label className="field-label nickname-label" htmlFor="nickname">Dein Nickname</label>
            <input
              className="text-input"
              id="nickname"
              name="nickname"
              autoComplete="nickname"
              maxLength={MAX_NICKNAME_LENGTH}
              placeholder="Wie soll die Klasse dich nennen?"
              value={nickname}
              onChange={(event) => setNickname(event.target.value)}
              aria-describedby="nickname-help"
              disabled={!hasSupabaseConfig || joining}
            />
            <span className="field-help" id="nickname-help">Bitte keine persönlichen Daten eingeben.</span>
            {joinError && <p className="form-error" role="alert">{joinError}</p>}
            {hasSupabaseConfig && (
              <button className="button button-primary join-button" type="submit" disabled={joining}>
                {joining ? <><LoaderCircle size={18} className="spin" aria-hidden="true" /> Verbindung wird hergestellt …</> : <>Zur Stunde <ArrowRight size={18} aria-hidden="true" /></>}
              </button>
            )}
          </form>
          {!hasSupabaseConfig && <DemoActivity choice={demoChoice} answered={demoAnswered} onChoice={setDemoChoice} onAnswer={() => setDemoAnswered(true)} />}
        </section>
      </section>

      <section className="how-it-works" aria-label="So funktioniert Connect">
        <div><span className="step-number">01</span><div><strong>Code eingeben</strong><p>Du bekommst ihn in deiner Stunde.</p></div></div>
        <div><span className="step-number">02</span><div><strong>Nickname wählen</strong><p>Ein Name reicht völlig aus.</p></div></div>
        <div><span className="step-number">03</span><div><strong>Mitmachen</strong><p>Fragen beantworten und Ideen teilen.</p></div></div>
      </section>
      <footer className="site-footer">PLEXIA Connect · Gemeinsam lernen, ohne Anmeldung.</footer>
    </main>
  );
}

function DemoModeBanner() {
  return (
    <div className="demo-banner" role="status">
      <div className="demo-banner-icon"><Cloud size={17} aria-hidden="true" /></div>
      <div><strong>Demomodus – keine echte Teilnahme</strong><span>Die Verbindung zum Klassenraum ist noch nicht eingerichtet. Probiere unten eine Beispielaufgabe aus.</span></div>
    </div>
  );
}

function DemoActivity({ choice, answered, onChoice, onAnswer }: { choice: string; answered: boolean; onChoice: (value: string) => void; onAnswer: () => void }) {
  const demoSlide = demoPresentation.slides[0];
  const options = demoSlide.content.options ?? [];
  return (
    <section className="demo-activity" aria-labelledby="demo-title">
      <div className="demo-activity-heading"><span className="demo-tag">BEISPIELAUFGABE</span><span className="demo-local"><LockKeyhole size={13} aria-hidden="true" /> nur lokal</span></div>
      <h3 id="demo-title">{demoSlide.title}</h3>
      <p>{contentText(demoSlide.content.question)}</p>
      <div className="demo-options">
        {options.map((option) => (
          <label className={`demo-option${choice === option ? " selected" : ""}`} key={option}>
            <input type="radio" name="demo-answer" value={option} checked={choice === option} disabled={answered} onChange={() => onChoice(option)} />
            <span className="custom-radio" aria-hidden="true" />{option}
          </label>
        ))}
      </div>
      {answered ? (
        <p className={`demo-feedback ${choice === options[0] ? "correct" : "try-again"}`} role="status">
          {choice === options[0] ? "Genau! Pflanzen brauchen Licht, Wasser und Luft." : "Danke fürs Ausprobieren. Pflanzen brauchen Licht, Wasser und Luft."}
          <span>Diese Antwort wurde nicht an eine Lehrkraft gesendet.</span>
        </p>
      ) : (
        <button className="button button-secondary demo-submit" type="button" disabled={!choice} onClick={onAnswer}>Antwort ausprobieren <ArrowRight size={16} aria-hidden="true" /></button>
      )}
    </section>
  );
}

function SessionView({
  bundle,
  nickname,
  sessionError,
  syncHealthy,
  onRefresh,
  sentNotice,
  onNotice,
  onError,
  onLeave,
}: {
  bundle: SessionBundle;
  nickname: string;
  sessionError: string;
  syncHealthy: boolean;
  onRefresh: () => void;
  sentNotice: string;
  onNotice: (message: string) => void;
  onError: (message: string) => void;
  onLeave: () => void;
}) {
  const { session, presentation } = bundle;
  const drafts = useRef<Record<string, StudentDraft>>({});
  const writing = useRef(new Set<string>());
  const [writingSlides, setWritingSlides] = useState<string[]>([]);
  const [completedWrites, setCompletedWrites] = useState<Record<string, number>>({});
  const hasDraft = () => Object.values(drafts.current).some((draft) => draft.dirty);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (Object.values(drafts.current).some((draft) => draft.dirty)) {
        event.preventDefault(); event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);
  const leaveWithWarning = () => {
    if (hasDraft() && !window.confirm("Du hast noch nicht gesendete Eingaben. Beim Verlassen gehen diese Entwürfe verloren. Wirklich verlassen?")) return;
    onLeave();
  };
  const beginSubmit = (id: string) => {
    if (writing.current.has(id)) return false;
    writing.current.add(id); setWritingSlides([...writing.current]); return true;
  };
  const endSubmit = (id: string, success: boolean) => {
    writing.current.delete(id); setWritingSlides([...writing.current]);
    if (success) setCompletedWrites((current) => ({ ...current, [id]: (current[id] ?? 0) + 1 }));
  };
  // Do not substitute the last slide for an out-of-date/invalid server index.
  const index = session.currentSlideIndex;
  const slide = presentation.slides[index];
  const previousSlideIndex = useRef(index);
  const slideDirection = index < previousSlideIndex.current ? "back" : "forward";
  useEffect(() => { previousSlideIndex.current = index; }, [index]);
  const status = displayStatus(session);
  const unavailable = sessionIsUnavailable(session);
  return (
    <>
      <div className="session-heading">
        <button className="back-button" type="button" onClick={leaveWithWarning}><ArrowLeft size={17} aria-hidden="true" /> Zurück</button>
        <div className={`session-status status-${status.tone}`} role="status"><span className="status-dot" />{status.label}</div>
      </div>
      <section className="session-overview">
        <div className="session-title-block">
          <span className="eyebrow"><UsersRound size={15} aria-hidden="true" /> DEINE KLASSE</span>
          <h1>{presentation.title}</h1>
          <p>Hallo, {nickname}. Du bist dabei – viel Spaß beim Mitmachen.</p>
        </div>
        {presentation.slides.length > 0 && <div className="slide-counter"><span>{String(index + 1).padStart(2, "0")}</span><i />{String(presentation.slides.length).padStart(2, "0")} Folien</div>}
      </section>
      {sessionError && <div className="inline-error" role="alert">{sessionError}</div>}
      {unavailable && <PausedNotice status={status} activityStatus={session.activityStatus} onLeave={leaveWithWarning} />}
      {slide ? (
        <div hidden={unavailable} className={`session-slide-transition ${slideDirection}`}><SlideView
          key={`${session.id}-${slide.id}`}
          slide={slide}
          session={session}
          nickname={nickname}
          sentNotice={sentNotice}
          onNotice={onNotice}
          onError={onError}
          syncHealthy={syncHealthy}
          onRefresh={onRefresh}
          drafts={drafts}
          submitting={writingSlides.includes(slide.id)}
          beginSubmit={beginSubmit}
          endSubmit={endSubmit}
          completedWrites={completedWrites[slide.id] ?? 0}
        /></div>
      ) : !unavailable ? (
        <div className="empty-slide"><CircleHelp size={24} aria-hidden="true" /><h2>Folie noch nicht verfügbar</h2><p>Warte kurz, bis der aktuelle Stundenstand abgeglichen ist oder deine Lehrkraft eine Folie auswählt.</p></div>
      ) : null}
      <p className="session-footnote"><LockKeyhole size={14} aria-hidden="true" /> Deine Antworten werden nur mit deinem Nickname dieser Stunde zugeordnet.</p>
    </>
  );
}

function PausedNotice({ status, activityStatus, onLeave }: { status: { label: string; tone: string }; activityStatus: ClassSession["activityStatus"]; onLeave: () => void }) {
  const ended = status.tone === "ended";
  const waitingToStart = activityStatus === "idle";
  return (
    <section className={`pause-card ${ended ? "ended" : "paused"}`}>
      <div className="pause-icon">{ended ? <CheckCircle2 size={27} aria-hidden="true" /> : <Radio size={27} aria-hidden="true" />}</div>
      <span className="eyebrow">{ended ? "BIS ZUM NÄCHSTEN MAL" : waitingToStart ? "GLEICH GEHT ES LOS" : "KURZE PAUSE"}</span>
      <h2>{ended ? "Die Stunde ist beendet." : waitingToStart ? "Die Stunde hat noch nicht begonnen." : "Die Stunde macht gerade Pause."}</h2>
      <p>{ended ? "Deine Lehrkraft hat die Stunde beendet. Du kannst diese Ansicht jetzt schließen." : waitingToStart ? "Sobald deine Lehrkraft die Aktivität startet, erscheint die Aufgabe hier automatisch." : "Sobald deine Lehrkraft weitermacht, erscheint die Aufgabe hier automatisch."}</p>
      {ended && <button type="button" className="button button-secondary" onClick={onLeave}>Zur Startseite <ArrowRight size={17} aria-hidden="true" /></button>}
    </section>
  );
}

function SlideView({
  slide,
  session,
  nickname,
  sentNotice,
  onNotice,
  onError,
  syncHealthy,
  onRefresh,
  drafts,
  submitting,
  beginSubmit,
  endSubmit,
  completedWrites,
}: {
  slide: PlexiaSlide;
  session: ClassSession;
  nickname: string;
  sentNotice: string;
  onNotice: (message: string) => void;
  onError: (message: string) => void;
  syncHealthy: boolean;
  onRefresh: () => void;
  drafts: React.RefObject<Record<string, StudentDraft>>;
  submitting: boolean;
  beginSubmit: (id: string) => boolean;
  endSubmit: (id: string, success: boolean) => void;
  completedWrites: number;
}) {
  const savedDraft = drafts.current[slide.id];
  const [answer, setAnswer] = useState(savedDraft?.answer ?? "");
  const [selected, setSelected] = useState<string[]>(savedDraft?.selected ?? []);
  const [ideas, setIdeas] = useState<string[]>(savedDraft?.ideas ?? []);
  const [ideaDraft, setIdeaDraft] = useState(savedDraft?.ideaDraft ?? "");
  const [photo, setPhoto] = useState<File | null>(savedDraft?.photo ?? null);
  const [uploadedPhoto, setUploadedPhoto] = useState<StudentDraft["uploadedPhoto"]>(savedDraft?.uploadedPhoto ?? null);
  const dirty = useRef(savedDraft?.dirty ?? false);
  const mounted = useRef(true);
  const previousCompletedWrites = useRef(completedWrites);
  const [responseLoading, setResponseLoading] = useState(true);
  const [hasExistingResponse, setHasExistingResponse] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const [groupNumber, setGroupNumber] = useState<number | null>(null);
  const [groupError, setGroupError] = useState("");
  const [photoError, setPhotoError] = useState("");
  const supportsIdeas = slide.type === "mindmap" || slide.type === "brainstorm" || slide.type === "wordcloud";
  const isChoice = slide.type === "multiple_choice" || slide.type === "poll";
  const isOpenResponse = slide.type === "free_text" || slide.type === "worksheet" || slide.type === "photo_task" || slide.type === "group_work";
  const canRespond = isChoice || isOpenResponse || supportsIdeas;
  const unavailable = sessionIsUnavailable(session) || !syncHealthy || reviewed;

  useEffect(() => {
    drafts.current[slide.id] = { answer, selected, ideas, ideaDraft, photo, uploadedPhoto, dirty: dirty.current };
  }, [drafts, slide.id, answer, selected, ideas, ideaDraft, photo, uploadedPhoto]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (completedWrites === previousCompletedWrites.current) return;
    previousCompletedWrites.current = completedWrites;
    dirty.current = false;
    setHasExistingResponse(true);
    setPhoto(null); setUploadedPhoto(null);
    onNotice("Deine Antwort ist angekommen. Du kannst sie auf dieser Folie noch korrigieren.");
  }, [completedWrites, onNotice]);
  useEffect(() => {
    let active = true;
    let groupTimer: number | undefined;
    if (!canRespond) return () => { active = false; };
    setResponseLoading(true);
    let groupScheduler: ReturnType<typeof createSnapshotScheduler> | undefined;
    const refreshGroup = () => groupScheduler?.request();
    if (slide.type === "group_work") {
      groupScheduler = createSnapshotScheduler(async (isCurrent) => {
        try {
          const assignment = await getMyGroupAssignment(session.id, slide.id);
          if (isCurrent()) { setGroupNumber(assignment?.groupNumber ?? null); setGroupError(""); }
        } catch {
          if (isCurrent()) setGroupError("Die Gruppenzuteilung konnte nicht abgeglichen werden.");
        }
      });
      groupScheduler.request();
      groupTimer = window.setInterval(() => groupScheduler?.request(false), 2500);
      window.addEventListener("online", refreshGroup);
      window.addEventListener("focus", refreshGroup);
    }
    void getStudentResponse(session.id, slide.id).then((response) => {
      if (!active || !response) return;
      setHasExistingResponse(true);
      setReviewed(Boolean(response.reviewed));
      if (dirty.current) return;
      if (supportsIdeas) {
        const savedIdeas = response.answerJson.ideas;
        setIdeas(Array.isArray(savedIdeas) ? savedIdeas.filter((idea): idea is string => typeof idea === "string") : response.answerText.split("\n").filter(Boolean));
      } else if (isChoice) {
        const savedChoices = response.answerJson.choices;
        setSelected(Array.isArray(savedChoices) ? savedChoices.filter((choice): choice is string => typeof choice === "string") : response.answerText.split(", ").filter(Boolean));
      } else {
        setAnswer(response.answerText);
      }
    }).catch((error) => {
      if (active) onError(errorMessage(error));
    }).finally(() => {
      if (active) setResponseLoading(false);
    });
    return () => {
      active = false; groupScheduler?.close();
      if (groupTimer !== undefined) window.clearInterval(groupTimer);
      window.removeEventListener("online", refreshGroup);
      window.removeEventListener("focus", refreshGroup);
    };
  }, [session.id, slide.id, canRespond, isChoice, supportsIdeas, onError]);

  const addIdea = () => {
    const next = ideaDraft.trim().slice(0, 180);
    if (!next || ideas.length >= 10) return;
    dirty.current = true;
    setIdeas((current) => [...current, next]);
    setIdeaDraft("");
  };

  const toggleOption = (option: string, multiple: boolean) => {
    dirty.current = true;
    setSelected((current) => multiple
      ? current.includes(option) ? current.filter((item) => item !== option) : [...current, option]
      : current.includes(option) ? [] : [option]);
  };

  const recheckReview = async () => {
    setResponseLoading(true);
    try {
      const response = await getStudentResponse(session.id, slide.id);
      if (!response) throw new Error("Deine Antwort konnte nicht gefunden werden.");
      if (mounted.current) {
        setReviewed(Boolean(response.reviewed));
        if (!response.reviewed) onNotice("Deine Lehrkraft hat die Antwort zur Korrektur freigegeben.");
      }
    } catch (error) {
      if (mounted.current) onError(errorMessage(error));
    } finally {
      if (mounted.current) setResponseLoading(false);
    }
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canRespond || unavailable || submitting) return;
    const answerText = supportsIdeas ? ideas.join("\n") : isChoice ? selected.join(", ") : answer.trim();
    if (!answerText && !photo) {
      onError("Gib zuerst eine Antwort ein oder füge ein Foto hinzu.");
      return;
    }
    if (answerText.length > MAX_ANSWER_LENGTH) {
      onError(`Deine Antwort darf höchstens ${MAX_ANSWER_LENGTH} Zeichen lang sein.`);
      return;
    }
    if (!beginSubmit(slide.id)) return;
    onError("");
    let success = false;
    try {
      let mediaPath: string | undefined;
      if (photo) {
        mediaPath = uploadedPhoto?.file === photo ? uploadedPhoto.path : await uploadStudentPhoto(session.id, photo);
        const uploaded = { file: photo, path: mediaPath };
        if (drafts.current[slide.id]) drafts.current[slide.id].uploadedPhoto = uploaded;
        if (mounted.current) setUploadedPhoto(uploaded);
      }
      await submitResponse({
        sessionId: session.id,
        slideId: slide.id,
        nickname,
        answerText,
        answerJson: supportsIdeas ? { ideas } : isChoice ? { choices: selected } : {},
        ...(mediaPath ? { mediaPath } : {}),
      });
      success = true;
      dirty.current = false;
      const draft = drafts.current[slide.id];
      if (draft) { draft.dirty = false; draft.photo = null; draft.uploadedPhoto = null; }
      if (mounted.current) {
        setHasExistingResponse(true);
        onNotice("Deine Antwort ist angekommen. Du kannst sie auf dieser Folie noch korrigieren.");
        setPhoto(null);
        setUploadedPhoto(null);
      }
      const input = document.getElementById(`photo-${slide.id}`) as HTMLInputElement | null;
      if (input) input.value = "";
    } catch (error) {
      onRefresh();
      onError(`Antwort zu „${slide.title}“: ${errorMessage(error)} Deine Eingaben bleiben als Entwurf erhalten.`);
    } finally {
      endSubmit(slide.id, success);
    }
  };

  const options = Array.isArray(slide.content.options) ? slide.content.options.filter((item): item is string => typeof item === "string") : [];
  const prompt = contentText(slide.content.question) || contentText(slide.content.prompt) || contentText(slide.content.instructions) || contentText(slide.content.body);
  const multiple = slide.content.allowMultiple === true;
  const typeLabel: Record<SlideType, string> = {
    standard: "FOLIE", video: "VIDEO", multiple_choice: "QUIZ", free_text: "DEINE ANTWORT", worksheet: "ARBEITSBLATT",
    photo_task: "FOTO-AUFGABE", mindmap: "MINDMAP", brainstorm: "IDEEN SAMMELN", wordcloud: "WORTWOLKE", poll: "UMFRAGE", group_work: "GRUPPENARBEIT", results: "ERGEBNISSE",
  };

  return (
    <section key={slide.id} className="slide-card slide-transition" aria-labelledby="slide-title">
      <div className="slide-card-top"><span className="slide-type"><span className="slide-type-icon">{iconForSlide(slide.type)}</span>{typeLabel[slide.type]}</span><span className="slide-number">FOLIE {session.currentSlideIndex + 1}</span></div>
      <h2 id="slide-title">{slide.title || typeLabel[slide.type]}</h2>
      {prompt && <p className="slide-prompt">{prompt}</p>}
      <SlideElements slide={slide} />
      <InteractionContent
        slide={slide}
        options={options}
        multiple={multiple}
        isChoice={isChoice}
        isOpenResponse={isOpenResponse}
        supportsIdeas={supportsIdeas}
        canRespond={canRespond}
        answer={answer}
        setAnswer={(value) => { dirty.current = true; setAnswer(value); }}
        selected={selected}
        toggleOption={toggleOption}
        ideas={ideas}
        ideaDraft={ideaDraft}
        setIdeaDraft={(value) => { dirty.current = true; setIdeaDraft(value); }}
        addIdea={addIdea}
        removeIdea={(value) => { dirty.current = true; setIdeas((current) => current.filter((_, index) => index !== value)); }}
        photo={photo}
        setPhoto={(file) => { dirty.current = true; setPhoto(file); setUploadedPhoto(null); }}
        photoError={photoError}
        setPhotoError={setPhotoError}
        submitting={submitting}
        responseLoading={responseLoading}
        hasExistingResponse={hasExistingResponse}
        reviewed={reviewed}
        onRecheckReview={() => void recheckReview()}
        unavailable={unavailable}
        sentNotice={sentNotice}
        groupNumber={groupNumber}
        groupError={groupError}
        onSubmit={submit}
      />
      {slide.type === "results" && <SharedResultsView value={slide.content.sharedResults} />}
      <SlideNavigation />
    </section>
  );
}

function iconForSlide(type: SlideType) {
  switch (type) {
    case "video": return <Video size={16} aria-hidden="true" />;
    case "multiple_choice":
    case "poll": return <CircleHelp size={16} aria-hidden="true" />;
    case "mindmap":
    case "brainstorm":
    case "wordcloud": return <Lightbulb size={16} aria-hidden="true" />;
    case "group_work": return <UsersRound size={16} aria-hidden="true" />;
    case "photo_task": return <ImagePlus size={16} aria-hidden="true" />;
    case "free_text":
    case "worksheet": return <MessageCircle size={16} aria-hidden="true" />;
    default: return <Sparkles size={16} aria-hidden="true" />;
  }
}

function SlideElements({ slide }: { slide: PlexiaSlide }) {
  const contentVideo = [slide.content.videoUrl, slide.content.url, slide.content.src, slide.content.video]
    .find((value): value is string => typeof value === "string" && value.trim().length > 0);
  const hasVideoElement = slide.elements.some((element) => element.kind === "video" && Boolean(element.content));
  if (!slide.elements.length && !(slide.type === "video" && contentVideo)) return null;
  return (
    <div className="slide-elements">
      {slide.type === "video" && contentVideo && !hasVideoElement && <PresentationMedia src={contentVideo} kind="video" />}
      {[...slide.elements].sort((a, b) => a.y - b.y || a.x - b.x || a.zIndex - b.zIndex).map((element) => {
        // Optional editor formatting is read defensively until both shared models are synchronized.
        const formatted = element as typeof element & { fontSize?: number; fontWeight?: string; fontStyle?: string; textAlign?: string };
        const style: React.CSSProperties = {
          color: element.color || undefined, background: element.background && element.background !== "transparent" ? element.background : undefined,
          fontSize: typeof formatted.fontSize === "number" && Number.isFinite(formatted.fontSize) ? `${Math.max(14, Math.min(32, formatted.fontSize * 0.7))}px` : undefined,
          fontWeight: formatted.fontWeight === "bold" ? "bold" : formatted.fontWeight === "normal" ? "normal" : undefined,
          fontStyle: formatted.fontStyle === "italic" ? "italic" : undefined,
          textAlign: formatted.textAlign === "center" || formatted.textAlign === "right" || formatted.textAlign === "left" ? formatted.textAlign : undefined,
          whiteSpace: "pre-wrap", overflowWrap: "anywhere",
        };
        if (element.kind === "image" && element.content) return <PresentationMedia key={element.id} src={element.content} kind="image" alt={element.alt || "Bild auf der Folie"} />;
        if (element.kind === "video" && element.content) return <PresentationMedia key={element.id} src={element.content} kind="video" />;
        if (element.kind === "table" && element.rows?.length) return <div className="table-scroll" key={element.id}><table><tbody>{element.rows.map((row, rowIndex) => <tr key={`${element.id}-${rowIndex}`}>{row.map((cell, cellIndex) => <td key={`${element.id}-${rowIndex}-${cellIndex}`}>{cell}</td>)}</tr>)}</tbody></table></div>;
        if (element.kind === "chart" && element.points?.length) return <div className="chart-list" key={element.id}>{element.points.map((point) => <div className="chart-row" key={`${element.id}-${point.label}`}><span>{point.label}</span><progress max="100" value={Math.max(0, Math.min(point.value, 100))}>{point.value}%</progress><b>{point.value}</b></div>)}</div>;
        if (element.kind === "shape" && element.shape === "line") return <hr className="slide-rule" key={element.id} />;
        if (!element.content) return null;
        return <p className="slide-element-text" style={style} key={element.id}>{element.content}</p>;
      })}
    </div>
  );
}

function isDirectMediaUrl(value: string): boolean {
  return /^(https?:\/\/|blob:|data:)/i.test(value.trim());
}

function PresentationMedia({ src, kind, alt }: { src: string; kind: "image" | "video"; alt?: string }) {
  const directUrl = isDirectMediaUrl(src);
  const [url, setUrl] = useState<string | null>(() => directUrl ? src : null);
  const [loading, setLoading] = useState(!directUrl);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    if (!src.trim()) {
      setUrl(null);
      setLoading(false);
      setError("Für dieses Medium ist keine Quelle angegeben.");
    } else if (isDirectMediaUrl(src)) {
      setUrl(src);
      setLoading(false);
      setError("");
    } else {
      setUrl(null);
      setLoading(true);
      setError("");
      void createSignedPresentationUrl(src).then((signedUrl) => {
        if (!active) return;
        setUrl(signedUrl);
        setLoading(false);
      }).catch(() => {
        if (!active) return;
        setError("Dieses private Medium kann gerade nicht geladen werden.");
        setLoading(false);
      });
    }
    return () => { active = false; };
  }, [src]);

  if (loading) return <div className="slide-media-status" role="status">Medium wird sicher geladen …</div>;
  if (error || !url) return <div className="slide-media-status" role="alert">{error || "Dieses Medium ist nicht verfügbar."}</div>;
  if (kind === "image") {
    return <figure className="slide-element-image"><img src={url} alt={alt || "Bild auf der Folie"} loading="lazy" onError={() => setError("Das Bild konnte nicht angezeigt werden.")} /></figure>;
  }
  return <video className="slide-element-video" controls playsInline preload="metadata" src={url} onError={() => setError("Das Video konnte nicht abgespielt werden.")}>Dein Browser kann dieses Video nicht abspielen.</video>;
}

function InteractionContent(props: {
  slide: PlexiaSlide;
  options: string[];
  multiple: boolean;
  isChoice: boolean;
  isOpenResponse: boolean;
  supportsIdeas: boolean;
  canRespond: boolean;
  answer: string;
  setAnswer: (value: string) => void;
  selected: string[];
  toggleOption: (option: string, multiple: boolean) => void;
  ideas: string[];
  ideaDraft: string;
  setIdeaDraft: (value: string) => void;
  addIdea: () => void;
  removeIdea: (index: number) => void;
  photo: File | null;
  setPhoto: (file: File | null) => void;
  photoError: string;
  setPhotoError: (message: string) => void;
  submitting: boolean;
  responseLoading: boolean;
  hasExistingResponse: boolean;
  reviewed: boolean;
  onRecheckReview: () => void;
  unavailable: boolean;
  sentNotice: string;
  groupNumber: number | null;
  groupError: string;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const { slide, options, multiple, isChoice, isOpenResponse, supportsIdeas, canRespond, answer, setAnswer, selected, toggleOption, ideas, ideaDraft, setIdeaDraft, addIdea, removeIdea, photo, setPhoto, photoError, setPhotoError, submitting, responseLoading, hasExistingResponse, reviewed, onRecheckReview, unavailable, sentNotice, groupNumber, groupError, onSubmit } = props;
  if (!canRespond) {
    if (slide.type === "results") return null;
    if (slide.type === "video") return <div className="slide-guidance"><Video size={18} aria-hidden="true" /> Schau dir das Video gemeinsam mit deiner Klasse an.</div>;
    return <div className="slide-guidance">Lies die Folie in Ruhe durch und folge den Hinweisen deiner Lehrkraft.</div>;
  }
  return (
    <form className="response-form" onSubmit={onSubmit}>
      {isChoice && (
        <fieldset className="choice-fieldset" disabled={unavailable || submitting || responseLoading}>
          <legend>{multiple ? "Wähle eine oder mehrere Antworten:" : "Wähle eine Antwort:"}</legend>
          <div className="choice-list">
            {options.map((option, index) => (
              <label className={`choice-option${selected.includes(option) ? " selected" : ""}`} key={`${option}-${index}`}>
                <input type={multiple ? "checkbox" : "radio"} name={`slide-answer-${slide.id}`} checked={selected.includes(option)} onChange={() => toggleOption(option, multiple)} />
                <span className={multiple ? "custom-check" : "custom-radio"} aria-hidden="true">{multiple && selected.includes(option) && <Check size={13} />}</span>
                <span>{option}</span>
              </label>
            ))}
            {!options.length && <p className="field-help">Für diese Frage wurden noch keine Antwortmöglichkeiten hinzugefügt.</p>}
          </div>
        </fieldset>
      )}
      {supportsIdeas && (
        <div className={`ideas-box ideas-${slide.type}`}>
          <label className="field-label" htmlFor={`idea-${slide.id}`}>{slide.type === "wordcloud" ? "Dein Wort oder Begriff" : "Deine Idee"}</label>
          <div className="idea-entry"><input className="text-input" id={`idea-${slide.id}`} value={ideaDraft} maxLength={180} placeholder="Schreib eine kurze Idee …" onChange={(event) => setIdeaDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addIdea(); } }} disabled={unavailable || submitting || responseLoading || ideas.length >= 10} /><button className="button button-add" type="button" onClick={addIdea} disabled={!ideaDraft.trim() || unavailable || submitting || responseLoading || ideas.length >= 10} aria-label="Idee hinzufügen"><span>Hinzufügen</span><ArrowRight size={16} aria-hidden="true" /></button></div>
          <p className="field-help">Bis zu 10 Ideen, jeweils maximal 180 Zeichen.</p>
          {ideas.length > 0 && <ul className="idea-list">{ideas.map((idea, index) => <li key={`${idea}-${index}`}><span>{idea}</span><button type="button" onClick={() => removeIdea(index)} aria-label={`Idee entfernen: ${idea}`} disabled={unavailable || submitting || responseLoading}><X size={15} aria-hidden="true" /></button></li>)}</ul>}
        </div>
      )}
      {isOpenResponse && (
        <div className="answer-box">
          {slide.type === "group_work" && <div className="group-badge" role="status">{groupError || (groupNumber ? `Du bist in Gruppe ${groupNumber}` : "Deine Lehrkraft teilt dich gleich einer Gruppe zu.")}</div>}
          <label className="field-label" htmlFor={`answer-${slide.id}`}>{slide.type === "photo_task" ? "Beschreibe dein Ergebnis (optional)" : slide.type === "worksheet" ? "Deine Lösung" : slide.type === "group_work" ? "Was hat eure Gruppe erarbeitet?" : "Deine Antwort"}</label>
          <textarea id={`answer-${slide.id}`} className="text-input answer-input" maxLength={MAX_ANSWER_LENGTH} value={answer} onChange={(event) => setAnswer(event.target.value)} placeholder={slide.type === "photo_task" ? "Du kannst stattdessen oder zusätzlich ein Foto hinzufügen …" : "Schreib deine Antwort hier …"} disabled={unavailable || submitting || responseLoading} rows={5} />
          <div className="answer-meta"><span>Nur deine Lehrkraft sieht deine Antwort.</span><span>{answer.length}/{MAX_ANSWER_LENGTH}</span></div>
        </div>
      )}
      {(slide.type === "photo_task" || slide.type === "worksheet" || slide.type === "free_text" || slide.type === "group_work") && (
        <div className="photo-upload">
          <label className="field-label" htmlFor={`photo-${slide.id}`}>Foto hinzufügen <span className="optional-label">optional</span></label>
          <div className="upload-control"><input id={`photo-${slide.id}`} type="file" accept=".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp" capture="environment" disabled={unavailable || submitting || responseLoading} onChange={(event: ChangeEvent<HTMLInputElement>) => { const file = event.target.files?.[0] ?? null; setPhotoError(""); if (file && !["image/png", "image/jpeg", "image/webp"].includes(file.type)) { setPhoto(null); setPhotoError("Dieses Bildformat wird nicht unterstützt. Bitte wähle PNG, JPEG oder WebP; HEIC kann hier nicht hochgeladen werden."); event.target.value = ""; return; } if (file && file.size > 12 * 1024 * 1024) { setPhoto(null); setPhotoError("Das Foto darf höchstens 12 MB groß sein."); event.target.value = ""; return; } setPhoto(file); }} /><span className="upload-button"><ImagePlus size={17} aria-hidden="true" /> Foto auswählen</span><span className="upload-name">{photo?.name ?? "PNG, JPEG oder WebP · max. 12 MB"}</span></div>
          {photoError && <p className="form-error" role="alert">{photoError}</p>}
        </div>
      )}
      {sentNotice && <div className="success-notice" role="status"><CheckCircle2 size={19} aria-hidden="true" /><span>{sentNotice}</span></div>}
      {unavailable && <p className="field-help">{reviewed ? "Deine Antwort wurde bereits bewertet und kann nicht mehr geändert werden. Sprich mit deiner Lehrkraft, wenn du etwas korrigieren möchtest." : "Du kannst gerade nichts absenden. Warte auf den aktuellen Stundenstand oder bis die Stunde fortgesetzt wird."}</p>}
      {reviewed && <button className="button button-secondary" type="button" onClick={onRecheckReview} disabled={responseLoading || submitting}>Freigabe prüfen</button>}
      {responseLoading && <p className="field-help" role="status">Deine gespeicherte Antwort wird geladen …</p>}
      <button className="button button-primary submit-button" type="submit" disabled={unavailable || submitting || responseLoading || (isChoice && selected.length === 0 && !photo) || (supportsIdeas && ideas.length === 0 && !photo) || (isOpenResponse && !answer.trim() && !photo)}>
        {submitting ? <><LoaderCircle size={18} className="spin" aria-hidden="true" /> Wird gesendet …</> : <>{reviewed ? "Bereits bewertet" : hasExistingResponse ? "Antwort korrigieren" : "Antwort senden"} <Send size={17} aria-hidden="true" /></>}
      </button>
      <p className="response-privacy"><LockKeyhole size={13} aria-hidden="true" /> Deine Antwort wird mit deinem Nickname an die Lehrkraft übermittelt.</p>
    </form>
  );
}

function SlideNavigation() {
  return (
    <div className="slide-navigation" aria-label="Folienstatus">
      <span><span className="live-dot" /> Folienwechsel durch die Lehrkraft</span>
      <span>Die Ansicht aktualisiert sich automatisch.</span>
    </div>
  );
}

export default App;
