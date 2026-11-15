/* =====================================================================
   auth.js — email/password login via Supabase Auth.
   * Sessions are stored per browser, so the same account can be signed in
     on several phones at once. Logging out only affects THIS device.
   * After login we also check public.profiles.is_active, so a stray extra
     account (if sign-ups were ever left on) cannot enter the dashboard.
   ===================================================================== */
(function () {
  'use strict';
  const PM = window.PM;

  PM.auth = {
    user: null,

    /** Returns the signed-in, authorised user or null. */
    async restore() {
      const { data, error } = await PM.db.auth.getSession();
      if (error || !data.session) return null;
      return this._authorise(data.session.user);
    },

    async signIn(email, password) {
      const { data, error } = await PM.db.auth.signInWithPassword({ email, password });
      if (error) {
        if (/invalid login credentials/i.test(error.message)) throw new Error('Wrong email or password. / ইমেইল বা পাসওয়ার্ড ভুল।');
        throw error;
      }
      return this._authorise(data.user);
    },

    async _authorise(user) {
      const { data, error } = await PM.db.from('profiles').select('is_active').eq('id', user.id).maybeSingle();
      if (error) throw error;
      if (!data || !data.is_active) {
        await PM.db.auth.signOut({ scope: 'local' });
        throw new Error('This account is not authorised for this shop.');
      }
      this.user = user;
      return user;
    },

    async signOut() {
      // scope "local": other phones stay logged in
      await PM.db.auth.signOut({ scope: 'local' });
      this.user = null;
    },

    /** Call fn when the session ends (token revoked, signed out, etc.). */
    onSignedOut(fn) {
      PM.db.auth.onAuthStateChange((event) => {
        if (event === 'SIGNED_OUT') setTimeout(fn, 0);   // never await supabase calls inside this callback
      });
    }
  };
})();
