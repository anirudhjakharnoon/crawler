"use client";

/**
 * Bootstraps Supabase anonymous auth on first client load — no signup/login
 * UI, ever. This uid becomes the RLS key (`owner = auth.uid()`) and the
 * job-creation rate-limit key. Renders nothing visible; children are only
 * mounted once a session (new or existing) is confirmed.
 */
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";

interface AuthContextValue {
  userId: string | null;
  ready: boolean;
  error: string | null;
}

const AuthContext = createContext<AuthContextValue>({ userId: null, ready: false, error: null });

export function useAuth(): AuthContextValue {
  return useContext(AuthContext);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthContextValue>({ userId: null, ready: false, error: null });

  useEffect(() => {
    let mounted = true;
    let supabase: ReturnType<typeof getSupabaseBrowserClient>;
    try {
      supabase = getSupabaseBrowserClient();
    } catch (err) {
      setState({
        userId: null,
        ready: true,
        error: err instanceof Error ? err.message : "Supabase client is not configured",
      });
      return;
    }

    async function bootstrap() {
      const { data: sessionData } = await supabase.auth.getSession();
      if (sessionData.session) {
        if (mounted) {
          setState({ userId: sessionData.session.user.id, ready: true, error: null });
        }
        return;
      }

      const { data, error } = await supabase.auth.signInAnonymously();
      if (!mounted) return;
      if (error || !data.session) {
        setState({ userId: null, ready: true, error: error?.message ?? "Failed to start session" });
        return;
      }
      setState({ userId: data.session.user.id, ready: true, error: null });
    }

    void bootstrap();

    const { data: subscription } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!mounted) return;
      setState((prev) => ({ ...prev, userId: session?.user.id ?? prev.userId }));
    });

    return () => {
      mounted = false;
      subscription.subscription.unsubscribe();
    };
  }, []);

  return <AuthContext.Provider value={state}>{children}</AuthContext.Provider>;
}
