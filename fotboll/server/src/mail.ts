import nodemailer from 'nodemailer';
import type { Locale } from '@fotboll/shared';

/**
 * Outgoing email for invitations and password resets. Without SMTP settings
 * the message is only logged, and admins share links by hand instead
 * (WhatsApp, SMS), which the admin screen supports anyway.
 */
export interface Mailer {
  readonly enabled: boolean;
  send(msg: { to: string; subject: string; text: string }): Promise<void>;
}

export function createMailer(smtpUrl: string | undefined, from: string | undefined): Mailer {
  if (!smtpUrl || !from) {
    return {
      enabled: false,
      async send(msg) {
        console.info(`[mail disabled] to=${msg.to} subject=${msg.subject}\n${msg.text}`);
      },
    };
  }
  const transport = nodemailer.createTransport(smtpUrl);
  return {
    enabled: true,
    async send(msg) {
      await transport.sendMail({ from, ...msg });
    },
  };
}

/** Collects messages instead of sending them (tests). */
export function memoryMailer(): Mailer & { sent: { to: string; subject: string; text: string }[] } {
  const sent: { to: string; subject: string; text: string }[] = [];
  return {
    enabled: true,
    sent,
    async send(msg) {
      sent.push(msg);
    },
  };
}

type Purpose = 'invite' | 'reset';

const TEXTS: Record<Locale, Record<Purpose, { subject: string; body: string }>> = {
  en: {
    invite: {
      subject: 'Your account for {app}',
      body: 'Hello {name},\n\nYou have been invited to {app} by {federation}. Open the link to choose your password:\n\n{link}\n\nThe link works once and expires in {days} days.',
    },
    reset: {
      subject: 'Choose a new password for {app}',
      body: 'Hello {name},\n\nOpen the link to choose a new password:\n\n{link}\n\nThe link works once and expires in {hours} hours. If you did not ask for this, you can ignore this email.',
    },
  },
  so: {
    invite: {
      subject: 'Akoonkaaga {app}',
      body: 'Salaan {name},\n\n{federation} ayaa kugu martiqaaday {app}. Fur xiriirkan si aad u doorato furahaaga sirta ah:\n\n{link}\n\nXiriirku hal mar ayuu shaqeeyaa wuxuuna dhacayaa {days} maalmood kadib.',
    },
    reset: {
      subject: 'Dooro fure sir ah oo cusub – {app}',
      body: 'Salaan {name},\n\nFur xiriirkan si aad u doorato fure sir ah oo cusub:\n\n{link}\n\nXiriirku hal mar ayuu shaqeeyaa wuxuuna dhacayaa {hours} saacadood kadib. Haddii aadan adigu codsan, iska dhaaf fariintan.',
    },
  },
  ar: {
    invite: {
      subject: 'حسابك في {app}',
      body: 'مرحبًا {name}،\n\nدعاك {federation} إلى {app}. افتح الرابط لاختيار كلمة المرور:\n\n{link}\n\nيعمل الرابط مرة واحدة وتنتهي صلاحيته بعد {days} أيام.',
    },
    reset: {
      subject: 'اختر كلمة مرور جديدة لـ {app}',
      body: 'مرحبًا {name}،\n\nافتح الرابط لاختيار كلمة مرور جديدة:\n\n{link}\n\nيعمل الرابط مرة واحدة وتنتهي صلاحيته بعد {hours} ساعات. إذا لم تطلب ذلك فتجاهل هذه الرسالة.',
    },
  },
};

export function tokenEmail(
  purpose: Purpose,
  locale: string,
  vars: { name: string; federation: string; link: string; days: number; hours: number },
) {
  const t = TEXTS[(locale in TEXTS ? locale : 'en') as Locale][purpose];
  const fill = (s: string) =>
    s.replace(/\{(\w+)\}/g, (_, k: string) => (k === 'app' ? 'Nidaamka UKCS' : String(vars[k as keyof typeof vars] ?? '')));
  return { subject: fill(t.subject), text: fill(t.body) };
}
