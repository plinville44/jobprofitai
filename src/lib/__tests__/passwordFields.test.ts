import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import PasswordInput from "@/components/PasswordInput";

// Preston, Nov 26, 2026: sign-up needs a confirm password box and a way to
// see what was typed, and on the login page Tab went from Email to
// "Forgot password?" instead of into the password box.

const SRC = join(__dirname, "..", "..");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");
const flat = (rel: string) => read(rel).replace(/\s+/g, " ");

/** Every .tsx outside the tests, relative to src/, with forward slashes on Windows too. */
function tsxFiles(dir = SRC, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name !== "__tests__" && name !== "node_modules") tsxFiles(full, out);
    } else if (name.endsWith(".tsx")) {
      out.push(full.slice(SRC.length + 1).replace(/\\/g, "/"));
    }
  }
  return out;
}

describe("PasswordInput", () => {
  const html = renderToStaticMarkup(
    createElement(PasswordInput, { id: "pw", value: "", onChange: () => {}, className: "w-full border", containerClassName: "mt-1" })
  );

  it("starts hidden, with a button to show what was typed", () => {
    expect(html).toContain('type="password"');
    expect(html).toContain('aria-label="Show password"');
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain('aria-controls="pw"');
  });

  it("the eye button never submits the form, and comes after the field", () => {
    expect(html).toContain('<button type="button"');
    expect(html.indexOf("<input")).toBeLessThan(html.indexOf("<button"));
  });

  it("keeps margins on its wrapper, so the button lines up with the field", () => {
    expect(html).toContain('<div class="relative mt-1">');
    expect(html).toContain('class="w-full border pr-11"');
  });

  it("switches to plain text and back on click", () => {
    const component = flat("components/PasswordInput.tsx");
    expect(component).toContain('type={visible ? "text" : "password"}');
    expect(component).toContain("onClick={() => setVisible((v) => !v)}");
    expect(component).toContain('aria-label={visible ? "Hide password" : "Show password"}');
  });

  it("is used for every password field on the site", () => {
    const raw = tsxFiles().filter((f) => f !== "components/PasswordInput.tsx" && /type="password"/.test(read(f)));
    expect(raw).toEqual([]);
    for (const f of [
      "app/signup/SignupForm.tsx",
      "app/login/page.tsx",
      "app/login/intuit/IntuitLinkForm.tsx",
      "app/reset-password/ResetPasswordForm.tsx",
      "app/invite/[token]/AcceptInviteForm.tsx",
      "app/dashboard/settings/DeleteAccountForm.tsx",
      "app/dashboard/settings/DeleteCompanyForm.tsx",
    ]) {
      expect({ f, uses: read(f).includes("<PasswordInput") }).toEqual({ f, uses: true });
    }
  });
});

describe("choosing a password asks for it twice", () => {
  it("sign-up has a Confirm password box and stops on a mismatch before sending anything", () => {
    const signup = flat("app/signup/SignupForm.tsx");
    expect(signup).toContain('<label htmlFor="signup-confirm"');
    expect(signup).toContain('id="signup-confirm" required maxLength={200} autoComplete="new-password" value={confirm}');
    const check = signup.indexOf('if (password !== confirm) { setError("Those two passwords don\'t match."); return; }');
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(signup.indexOf('fetch("/api/auth/signup"'));
    // A hint once what's typed stops matching, not while it's still the start of the password.
    expect(signup).toContain('const confirmOff = confirm !== "" && !password.startsWith(confirm);');
  });

  it("a new team login from an invitation does too", () => {
    const invite = flat("app/invite/[token]/AcceptInviteForm.tsx");
    expect(invite).toContain('<label htmlFor="invite-confirm"');
    const check = invite.indexOf('if (props.mode === "new_login" && password !== confirm) { setError("Those two passwords don\'t match."); return; }');
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(invite.indexOf('fetch("/api/team/accept"'));
  });

  it("and so does a password reset, as before", () => {
    const reset = flat("app/reset-password/ResetPasswordForm.tsx");
    expect(reset).toContain("Confirm new password");
    expect(reset).toContain("if (password !== confirm) {");
  });
});

describe("Tab goes from Email straight into Password", () => {
  for (const [f, emailId, passwordId] of [
    ["app/login/page.tsx", "login-email", "login-password"],
    ["app/login/intuit/IntuitLinkForm.tsx", null, "link-password"],
  ] as const) {
    it(`${f}: Forgot password? comes after the password box`, () => {
      const page = read(f);
      const password = page.indexOf(`id="${passwordId}"`);
      const forgot = page.indexOf('href="/forgot-password"');
      expect(password).toBeGreaterThan(-1);
      expect(forgot).toBeGreaterThan(password);
      if (emailId) {
        const email = page.indexOf(`id="${emailId}"`);
        expect(email).toBeGreaterThan(-1);
        expect(email).toBeLessThan(password);
        // Nothing focusable between the two.
        const between = page.slice(email, password);
        expect(between).not.toMatch(/<(a|Link|button)\b/);
      }
    });
  }

  it("the login boxes are tied to their labels and tell password managers what they are", () => {
    const login = flat("app/login/page.tsx");
    expect(login).toContain('<label htmlFor="login-email"');
    expect(login).toContain('<label htmlFor="login-password"');
    expect(login).toContain('autoComplete="email"');
    expect(login).toContain('autoComplete="current-password"');
  });
});
