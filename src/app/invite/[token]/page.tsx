import type { Metadata } from "next";
import Link from "next/link";
import { LogoLink } from "@/components/marketing/Logo";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/auth";
import { findUsableInvite } from "@/lib/team";
import AcceptInviteForm from "./AcceptInviteForm";

export const metadata: Metadata = {
  title: "Join a JobProfitAI team",
  // The URL carries a live invitation token.
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export const dynamic = "force-dynamic";

export default async function InvitePage(props: { params: Promise<{ token: string }> }) {
  const { token } = await props.params;
  const invite = await findUsableInvite(token);
  const session = await getSession();
  const signedIn = session
    ? await prisma.user.findUnique({ where: { id: session.userId }, select: { email: true } })
    : null;
  const existingLogin = invite && !signedIn
    ? await prisma.user.findFirst({
        where: { email: { equals: invite.email, mode: "insensitive" } },
        select: { id: true },
      })
    : null;
  const inviter = invite ? invite.ownerName ?? invite.ownerEmail : "";
  const next = `/invite/${encodeURIComponent(token)}`;

  return (
    <main className="flex min-h-screen flex-col bg-jp-surface">
      <div className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center px-5 py-12">
        <div className="mb-8 flex justify-center">
          <LogoLink width={220} priority />
        </div>
        <div className="rounded-xl border border-jp-line bg-white p-7 sm:p-8">
          {!invite ? (
            <>
              <h1 className="text-xl font-bold text-navy">This invitation can&apos;t be used</h1>
              <p className="mt-3 text-sm text-jp-slate">
                It has expired, was already accepted, or was cancelled. Ask the person who invited you to send a new
                one from their Settings page.
              </p>
            </>
          ) : signedIn && signedIn.email.toLowerCase() !== invite.email ? (
            <>
              <h1 className="text-xl font-bold text-navy">Wrong login</h1>
              <p className="mt-3 text-sm text-jp-slate">
                This invitation is for <strong>{invite.email}</strong>, and you&apos;re signed in as{" "}
                <strong>{signedIn.email}</strong>. Log out, then open the invitation link again.
              </p>
            </>
          ) : (
            <>
              <h1 className="text-xl font-bold text-navy">Join {inviter} on JobProfitAI</h1>
              <p className="mt-3 text-sm text-jp-slate">
                {inviter} has invited <strong>{invite.email}</strong> to their account. You&apos;ll see their jobs,
                profit and reports with your own login. They can remove your access at any time.
              </p>
              {signedIn ? (
                <AcceptInviteForm token={token} mode="signed_in" />
              ) : existingLogin ? (
                <p className="mt-5 text-sm text-jp-slate">
                  There&apos;s already a JobProfitAI login for this address.{" "}
                  <Link href={`/login?next=${encodeURIComponent(next)}`} className="font-medium text-brand hover:underline">
                    Log in
                  </Link>{" "}
                  to accept.
                </p>
              ) : (
                <AcceptInviteForm token={token} mode="new_login" email={invite.email} />
              )}
            </>
          )}
        </div>
      </div>
    </main>
  );
}
