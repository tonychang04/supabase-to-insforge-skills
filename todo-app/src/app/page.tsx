"use client";

import { useEffect, useState } from "react";
import { insforge } from "@/lib/insforge";

type Todo = {
  id: string;
  title: string;
  completed: boolean;
  created_at: string;
  image_url?: string | null;
  image_key?: string | null;
};

type User = {
  id: string;
  email?: string;
  profile?: { name?: string };
};

function AuthForm({
  onSignedIn,
  signInWithGoogle,
}: {
  onSignedIn: (user: User) => void;
  signInWithGoogle: () => void;
}) {
  const [mode, setMode] = useState<"signin" | "signup" | "verify">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [otp, setOtp] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [loading, setLoading] = useState(false);
  const [resending, setResending] = useState(false);

  const handleSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    const { data, error: err } = await insforge.auth.signInWithPassword({
      email,
      password,
    });
    setLoading(false);
    if (err) {
      if (err.statusCode === 403) {
        setMode("verify");
        setError("Email not verified. Enter the 6-digit code from your inbox.");
      } else {
        setError(err.message);
      }
      return;
    }
    if (data?.user) {
      onSignedIn({
        id: data.user.id,
        email: data.user.email,
        profile: data.user.profile ?? undefined,
      });
    }
  };

  const handleSignUp = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    const { data, error: err } = await insforge.auth.signUp({
      email,
      password,
      name: name || undefined,
    });
    setLoading(false);
    if (err) {
      const msg = err.message.toLowerCase();
      if (
        msg.includes("already exists") ||
        msg.includes("already registered") ||
        msg.includes("user exists")
      ) {
        setMode("verify");
        setError(
          "An account with this email exists. Enter the verification code from your email, or use Resend to get a new one."
        );
      } else {
        setError(err.message);
      }
      return;
    }
    if (data?.requireEmailVerification) {
      setMode("verify");
      setError("");
      setSuccess("Sending verification code…");
      // Explicitly send verification email (backend may not send on signUp in some configs)
      const { error: sendErr } = await insforge.auth.resendVerificationEmail({
        email,
      });
      setSuccess(sendErr ? "" : "Verification code sent. Check your email.");
      if (sendErr) setError(sendErr.message);
    } else if (data?.accessToken && data?.user) {
      onSignedIn({
        id: data.user.id,
        email: data.user.email,
        profile: data.user.profile ?? undefined,
      });
    }
  };

  const handleVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setSuccess("");
    setLoading(true);
    const { data, error: err } = await insforge.auth.verifyEmail({
      email,
      otp,
    });
    setLoading(false);
    if (err) {
      setError(err.statusCode === 400 ? "Invalid or expired code" : err.message);
      return;
    }
    if (data?.user) {
      onSignedIn({
        id: data.user.id,
        email: data.user.email,
        profile: data.user.profile ?? undefined,
      });
    }
  };

  const handleResendCode = async () => {
    setError("");
    setSuccess("");
    setResending(true);
    const { error: err } = await insforge.auth.resendVerificationEmail({ email });
    setResending(false);
    if (err) {
      setError(err.message);
    } else {
      setSuccess("Verification code resent. Check your email.");
      setOtp("");
    }
  };

  return (
    <div className="rounded-xl border border-slate-700/50 bg-slate-800/30 p-8 text-slate-300">
      <p className="mb-6 text-center text-lg">
        Sign in to manage your todos.
      </p>

      {mode === "verify" ? (
        <form onSubmit={handleVerify} className="space-y-4">
          <p className="text-sm text-slate-400">
            Enter the 6-digit code sent to {email}
          </p>
          {success && (
            <p className="text-sm text-emerald-400">{success}</p>
          )}
          <input
            type="text"
            value={otp}
            onChange={(e) => setOtp(e.target.value.replace(/\D/g, "").slice(0, 6))}
            placeholder="000000"
            maxLength={6}
            className="w-full rounded-lg border border-slate-600 bg-slate-800/50 px-4 py-3 text-center text-lg tracking-[0.5em] text-slate-100 placeholder-slate-500 outline-none ring-amber-500/50 focus:border-amber-500 focus:ring-2"
            disabled={loading}
          />
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={loading || otp.length !== 6}
              className="flex-1 rounded-lg bg-amber-500 py-3 font-medium text-slate-900 transition hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {loading ? "Verifying…" : "Verify"}
            </button>
            <button
              type="button"
              onClick={handleResendCode}
              disabled={resending}
              className="rounded-lg border border-slate-600 px-4 py-3 text-sm transition hover:bg-slate-800 disabled:opacity-50"
            >
              {resending ? "Sending…" : "Resend"}
            </button>
          </div>
        </form>
      ) : (
        <>
          <form
            onSubmit={mode === "signin" ? handleSignIn : handleSignUp}
            className="space-y-4"
          >
            {mode === "signup" && (
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Name"
                className="w-full rounded-lg border border-slate-600 bg-slate-800/50 px-4 py-3 text-slate-100 placeholder-slate-500 outline-none ring-amber-500/50 focus:border-amber-500 focus:ring-2"
                disabled={loading}
              />
            )}
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="Email"
              required
              className="w-full rounded-lg border border-slate-600 bg-slate-800/50 px-4 py-3 text-slate-100 placeholder-slate-500 outline-none ring-amber-500/50 focus:border-amber-500 focus:ring-2"
              disabled={loading}
            />
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Password"
              required
              minLength={6}
              className="w-full rounded-lg border border-slate-600 bg-slate-800/50 px-4 py-3 text-slate-100 placeholder-slate-500 outline-none ring-amber-500/50 focus:border-amber-500 focus:ring-2"
              disabled={loading}
            />
            {error && (
              <p className="text-sm text-red-400">{error}</p>
            )}
            <button
              type="submit"
              disabled={loading}
              className="w-full rounded-lg bg-amber-500 py-3 font-medium text-slate-900 transition hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {loading
                ? mode === "signin"
                  ? "Signing in…"
                  : "Signing up…"
                : mode === "signin"
                  ? "Sign in"
                  : "Sign up"}
            </button>
          </form>

          <div className="mt-6 flex items-center gap-3">
            <div className="h-px flex-1 bg-slate-600" />
            <span className="text-sm text-slate-500">or</span>
            <div className="h-px flex-1 bg-slate-600" />
          </div>

          <button
            onClick={signInWithGoogle}
            className="mt-6 flex w-full items-center justify-center gap-2 rounded-lg bg-white px-6 py-3 font-medium text-slate-900 transition hover:bg-slate-100"
          >
            <svg className="h-5 w-5" viewBox="0 0 24 24">
              <path
                fill="#4285F4"
                d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
              />
              <path
                fill="#34A853"
                d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
              />
              <path
                fill="#FBBC05"
                d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
              />
              <path
                fill="#EA4335"
                d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
              />
            </svg>
            Sign in with Google
          </button>

          <p className="mt-6 text-center text-sm">
            {mode === "signin" ? (
              <>
                Don&apos;t have an account?{" "}
                <button
                  type="button"
                  onClick={() => {
                    setMode("signup");
                    setError("");
                  }}
                  className="text-amber-400 hover:underline"
                >
                  Sign up
                </button>
              </>
            ) : (
              <>
                Already have an account?{" "}
                <button
                  type="button"
                  onClick={() => {
                    setMode("signin");
                    setError("");
                  }}
                  className="text-amber-400 hover:underline"
                >
                  Sign in
                </button>
              </>
            )}
          </p>
        </>
      )}
    </div>
  );
}

const BUCKET = "todo-attachments";

function TodoList({ user }: { user: User }) {
  const [todos, setTodos] = useState<Todo[]>([]);
  const [newTitle, setNewTitle] = useState("");
  const [newFile, setNewFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState("");

  const fetchTodos = async () => {
    const { data, error } = await insforge.database
      .from("todos")
      .select("id, title, completed, created_at, image_url, image_key")
      .order("created_at", { ascending: false });

    if (error) {
      console.error("Failed to fetch todos:", error);
      setTodos([]);
    } else {
      setTodos(data ?? []);
    }
    setLoading(false);
  };

  useEffect(() => {
    fetchTodos();
  }, []);

  const addTodo = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTitle.trim() || submitting) return;

    setSubmitting(true);
    let imageUrl: string | null = null;
    let imageKey: string | null = null;

    if (newFile) {
      const { data: uploadData, error: uploadErr } = await insforge.storage
        .from(BUCKET)
        .uploadAuto(newFile);
      if (uploadErr) {
        console.error("Upload failed:", uploadErr);
      } else if (uploadData?.key && uploadData?.url) {
        imageUrl = uploadData.url;
        imageKey = uploadData.key;
      }
    }

    const { error } = await insforge.database
      .from("todos")
      .insert([
        {
          title: newTitle.trim(),
          user_id: user.id,
          ...(imageUrl && { image_url: imageUrl, image_key: imageKey }),
        },
      ]);

    if (error) {
      console.error("Failed to add todo:", error);
    } else {
      setNewTitle("");
      setNewFile(null);
      await fetchTodos();
    }
    setSubmitting(false);
  };

  const removeAttachment = async (id: string, imageKey: string) => {
    await insforge.storage.from(BUCKET).remove(imageKey);
    const { error } = await insforge.database
      .from("todos")
      .update({ image_url: null, image_key: null })
      .eq("id", id);
    if (!error) await fetchTodos();
  };

  const addAiSuggestions = async () => {
    const prompt = aiPrompt.trim() || "Suggest 3 productive tasks for today";
    setAiLoading(true);
    setAiError("");
    try {
      const { data, error: fnError } = await insforge.functions.invoke<
        { suggestions: string[] }
      >("todo-suggest", {
        body: { prompt },
        method: "POST",
      });

      if (fnError) {
        setAiError(fnError.message);
        return;
      }

      const suggestions = data?.suggestions ?? [];

      if (suggestions.length === 0) {
        setAiError("No suggestions returned. Try a different prompt.");
        return;
      }

      const rows = suggestions.map((title) => ({
        title,
        user_id: user.id,
      }));
      const { error } = await insforge.database.from("todos").insert(rows);
      if (error) {
        setAiError(error.message);
      } else {
        setAiPrompt("");
        await fetchTodos();
      }
    } catch (err) {
      setAiError(err instanceof Error ? err.message : "AI request failed");
    } finally {
      setAiLoading(false);
    }
  };

  const toggleTodo = async (id: string, completed: boolean) => {
    const { error } = await insforge.database
      .from("todos")
      .update({ completed: !completed })
      .eq("id", id);

    if (!error) {
      setTodos((prev) =>
        prev.map((t) => (t.id === id ? { ...t, completed: !completed } : t))
      );
    }
  };

  const deleteTodo = async (id: string) => {
    const { error } = await insforge.database
      .from("todos")
      .delete()
      .eq("id", id);

    if (!error) {
      setTodos((prev) => prev.filter((t) => t.id !== id));
    }
  };

  return (
    <>
      <form onSubmit={addTodo} className="mb-6">
        <div className="flex flex-col gap-2">
          <div className="flex gap-2">
            <input
              type="text"
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              placeholder="What needs to be done?"
              className="flex-1 rounded-lg border border-slate-600 bg-slate-800/50 px-4 py-3 text-slate-100 placeholder-slate-500 outline-none ring-amber-500/50 transition focus:border-amber-500 focus:ring-2"
              disabled={submitting}
            />
            <button
              type="submit"
              disabled={submitting || !newTitle.trim()}
              className="rounded-lg bg-amber-500 px-5 py-3 font-medium text-slate-900 transition hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Add
            </button>
          </div>
          <div className="flex items-center gap-2">
            <label className="cursor-pointer rounded-lg border border-slate-600 px-3 py-2 text-sm text-slate-400 transition hover:border-slate-500 hover:text-slate-300">
              <input
                type="file"
                className="hidden"
                accept="image/*"
                onChange={(e) => setNewFile(e.target.files?.[0] ?? null)}
              />
              {newFile ? newFile.name : "Attach image"}
            </label>
            {newFile && (
              <button
                type="button"
                onClick={() => setNewFile(null)}
                className="text-sm text-slate-500 hover:text-red-400"
              >
                Remove
              </button>
            )}
          </div>
        </div>
      </form>

      <div className="mb-8 flex flex-col gap-2 rounded-lg border border-slate-700/50 bg-slate-800/30 p-4">
        <label className="text-sm font-medium text-slate-400">AI Suggest</label>
        <div className="flex gap-2">
          <input
            type="text"
            value={aiPrompt}
            onChange={(e) => setAiPrompt(e.target.value)}
            placeholder="e.g. Suggest 3 productive tasks for today"
            className="flex-1 rounded-lg border border-slate-600 bg-slate-800/50 px-4 py-2 text-slate-100 placeholder-slate-500 outline-none ring-amber-500/50 transition focus:border-amber-500 focus:ring-2"
            disabled={aiLoading}
          />
          <button
            type="button"
            onClick={addAiSuggestions}
            disabled={aiLoading}
            className="rounded-lg border border-amber-500/50 bg-amber-500/10 px-4 py-2 text-sm font-medium text-amber-400 transition hover:bg-amber-500/20 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {aiLoading ? "…" : "Suggest"}
          </button>
        </div>
        {aiError && (
          <p className="text-sm text-red-400">{aiError}</p>
        )}
      </div>

      <div className="rounded-xl border border-slate-700/50 bg-slate-800/30 shadow-xl">
        {loading ? (
          <div className="flex justify-center py-12">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-amber-500 border-t-transparent" />
          </div>
        ) : todos.length === 0 ? (
          <p className="py-12 text-center text-slate-500">
            No todos yet. Add one above.
          </p>
        ) : (
          <ul className="divide-y divide-slate-700/50">
            {todos.map((todo) => (
              <li
                key={todo.id}
                className="group flex flex-col gap-2 px-4 py-3 transition hover:bg-slate-800/50"
              >
                <div className="flex items-center gap-3">
                  <button
                    onClick={() => toggleTodo(todo.id, todo.completed)}
                    className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md border-2 transition ${
                      todo.completed
                        ? "border-amber-500 bg-amber-500 text-slate-900"
                        : "border-slate-500 text-transparent hover:border-amber-500"
                    }`}
                  >
                    {todo.completed && (
                      <svg
                        className="h-3.5 w-3.5"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M5 13l4 4L19 7"
                        />
                      </svg>
                    )}
                  </button>
                  <span
                    className={`flex-1 ${
                      todo.completed
                        ? "text-slate-500 line-through"
                        : "text-slate-200"
                    }`}
                  >
                    {todo.title}
                  </span>
                  <div className="flex items-center gap-1">
                    {todo.image_key && (
                      <button
                        onClick={() =>
                          removeAttachment(todo.id, todo.image_key!)
                        }
                        className="rounded p-1.5 text-slate-500 opacity-0 transition hover:bg-slate-700 hover:text-red-400 group-hover:opacity-100"
                        aria-label="Remove attachment"
                      >
                        <svg
                          className="h-4 w-4"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M6 18L18 6M6 6l12 12"
                          />
                        </svg>
                      </button>
                    )}
                    <button
                      onClick={() => deleteTodo(todo.id)}
                      className="rounded p-1.5 text-slate-500 opacity-0 transition hover:bg-slate-700 hover:text-red-400 group-hover:opacity-100"
                      aria-label="Delete"
                    >
                      <svg
                        className="h-4 w-4"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                        />
                      </svg>
                    </button>
                  </div>
                </div>
                {todo.image_url && (
                  <a
                    href={todo.image_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="ml-9 block max-w-[200px] overflow-hidden rounded-lg border border-slate-600"
                  >
                    <img
                      src={todo.image_url}
                      alt=""
                      className="h-20 w-auto object-cover"
                    />
                  </a>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

export default function Home() {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [signingOut, setSigningOut] = useState(false);

  useEffect(() => {
    const checkSession = async () => {
      const { data } = await insforge.auth.getCurrentSession();
      const u = data?.session?.user;
      setUser(u ? { id: u.id, email: u.email, profile: u.profile ?? undefined } : null);
    };
    checkSession();
  }, []);

  const signInWithGoogle = async () => {
    await insforge.auth.signInWithOAuth({
      provider: "google",
      redirectTo: typeof window !== "undefined" ? window.location.origin : "/",
    });
  };

  const signOut = async () => {
    setSigningOut(true);
    await insforge.auth.signOut();
    setUser(null);
    setSigningOut(false);
  };

  if (user === undefined) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-amber-500 border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900">
      <div className="mx-auto max-w-xl px-4 py-16">
        <div className="mb-10 flex items-center justify-between">
          <h1 className="font-serif text-4xl font-bold tracking-tight text-amber-100">
            Todo
          </h1>
          {user && (
            <div className="flex items-center gap-3">
              <span className="text-sm text-slate-400">
                {user.profile?.name ?? user.email}
              </span>
              <button
                onClick={signOut}
                disabled={signingOut}
                className="rounded-lg border border-slate-600 px-4 py-2 text-sm text-slate-300 transition hover:bg-slate-800 disabled:opacity-50"
              >
                {signingOut ? "Signing out…" : "Sign out"}
              </button>
            </div>
          )}
        </div>

        {!user ? (
          <AuthForm
            onSignedIn={(u) =>
              setUser({ id: u.id, email: u.email, profile: u.profile ?? undefined })
            }
            signInWithGoogle={signInWithGoogle}
          />
        ) : (
          <TodoList user={user} />
        )}
      </div>
    </div>
  );
}
