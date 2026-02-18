import Handlebars from 'handlebars';
import nodemailer from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport';
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import config from './config';
import logging from './logging';
import dayjs from 'dayjs';

const log = logging('service:mail');
const { configString, configBoolean, configInteger } = config;

/** Config key prefix for transport options (includes trailing colon, e.g. mail:transport:). */
export const MAIL_TRANSPORT_CONFIG_PREFIX = 'mail:transport:';

/**
 * Build nodemailer createTransport() options from hs.utils config.
 * Uses configString, configBoolean, and configInteger under the given prefix.
 * Only includes properties that are set (or have a non-empty default).
 *
 * Supported config keys under `prefix`:
 * - host, port, service, name, authMethod, localAddress (string/integer)
 * - user, pass (auth; auth only added if at least user is set)
 * - secure, ignoreTLS, requireTLS, opportunisticTLS (boolean)
 * - connectionTimeout, greetingTimeout, socketTimeout, dnsTimeout (integer ms)
 * - transactionLog, debug (boolean)
 * - tls:rejectUnauthorized (boolean), tls:minVersion (string)
 */
export const getMailTransportConfig = (
  prefix: string = MAIL_TRANSPORT_CONFIG_PREFIX,
): SMTPTransport.Options => {
  const host = configString(`${prefix}host`, '');
  const port = configInteger(`${prefix}port`, 0);
  const service = configString(`${prefix}service`, '');
  const secure = configBoolean(`${prefix}secure`, false);
  const ignoreTLS = configBoolean(`${prefix}ignoreTLS`, false);
  const requireTLS = configBoolean(`${prefix}requireTLS`, false);
  const opportunisticTLS = configBoolean(`${prefix}opportunisticTLS`, false);
  const user = configString(`${prefix}user`, '');
  const pass = configString(`${prefix}pass`, '');
  const name = configString(`${prefix}name`, '');
  const localAddress = configString(`${prefix}localAddress`, '');
  const authMethod = configString(`${prefix}authMethod`, '');
  const connectionTimeout = configInteger(`${prefix}connectionTimeout`, 0);
  const greetingTimeout = configInteger(`${prefix}greetingTimeout`, 0);
  const socketTimeout = configInteger(`${prefix}socketTimeout`, 0);
  const dnsTimeout = configInteger(`${prefix}dnsTimeout`, 0);
  const transactionLog = configBoolean(`${prefix}transactionLog`, false);
  const debug = configBoolean(`${prefix}debug`, false);
  const tlsRejectUnauthorized = configBoolean(
    `${prefix}tls:rejectUnauthorized`,
    true,
  );
  const tlsMinVersion = configString(`${prefix}tls:minVersion`, '');

  const opts: SMTPTransport.Options = {};

  if (host !== '') opts.host = host;
  if (port > 0) opts.port = port;
  if (service !== '') opts.service = service;
  opts.secure = secure;
  opts.ignoreTLS = ignoreTLS;
  opts.requireTLS = requireTLS;
  opts.opportunisticTLS = opportunisticTLS;

  if (user !== '') {
    opts.auth = { user, pass };
  }

  if (name !== '') opts.name = name;
  if (localAddress !== '') opts.localAddress = localAddress;
  if (authMethod !== '') opts.authMethod = authMethod;
  if (connectionTimeout > 0) opts.connectionTimeout = connectionTimeout;
  if (greetingTimeout > 0) opts.greetingTimeout = greetingTimeout;
  if (socketTimeout > 0) opts.socketTimeout = socketTimeout;
  if (dnsTimeout > 0) opts.dnsTimeout = dnsTimeout;
  opts.transactionLog = transactionLog;
  opts.debug = debug;

  if (!tlsRejectUnauthorized || tlsMinVersion !== '') {
    opts.tls = {};
    if (!tlsRejectUnauthorized) opts.tls.rejectUnauthorized = false;
    if (tlsMinVersion !== '')
      opts.tls.minVersion = tlsMinVersion as
        | 'TLSv1'
        | 'TLSv1.1'
        | 'TLSv1.2'
        | 'TLSv1.3';
  }

  return opts;
};

export interface MailMessageConfig {
  from: string | { name: string; address: string };
  to: string | { name: string; address: string };
  subject: string;
}

export interface MailOptions {
  from: string | { name: string; address: string };
  to: string | { name: string; address: string };
  subject: string;
  text?: string | null;
  html?: string | null;
}

export type CreateMailer = (templatePath: string) => {
  render: (template: string, data: Record<string, unknown>) => Promise<string>;
  renderHtml: (
    template: string,
    data: Record<string, unknown>,
  ) => Promise<string>;
  renderText: (
    template: string,
    data: Record<string, unknown>,
  ) => Promise<string | null>;
  renderOptions: (
    template: string,
    data: Record<string, unknown>,
  ) => Promise<MailOptions>;
  send: (template: string, data: Record<string, unknown>) => Promise<void>;
};

export const createMailer: CreateMailer = (templatePath) => {
  const mailConfig = getMailTransportConfig();
  log.debug(`Creating mail transport: ${JSON.stringify(mailConfig)}`);
  const transport = nodemailer.createTransport(mailConfig);

  const mailPath = (template: string, ext: 'html' | 'text') =>
    join(templatePath, `${template}.${ext}.hbs`);

  const getMessageConfig = (template: string) => ({
    from: configString(`mail:messages:${template}:from`, ''),
    fromName: configString(`mail:messages:${template}:fromName`, ''),
    to: configString(`mail:messages:${template}:to`, ''),
    toName: configString(`mail:messages:${template}:toName`, ''),
    subject: configString(`mail:messages:${template}:subject`, ''),
  });

  const addVars = (
    data: Record<string, unknown>,
    template: string,
  ): Record<string, unknown> => {
    const msg = getMessageConfig(template);
    const vars = {
      ...data,
      mailConfig: msg,
      dayjs,
    };
    log.debug(`Seeding mail template with variables: ${JSON.stringify(vars)}`);
    return vars;
  };

  const loadTemplate = async (
    template: string,
    ext: 'html' | 'text',
  ): Promise<string> => {
    const path = mailPath(template, ext);
    if (!existsSync(path)) {
      throw new Error(`Mail template not found: ${path}`);
    }
    return readFile(path, { encoding: 'utf-8' });
  };

  const render =
    (ext: 'html' | 'text') =>
    async (
      template: string,
      data: Record<string, unknown>,
    ): Promise<string> => {
      const templateSource = await loadTemplate(template, ext);
      const compiled = Handlebars.compile(templateSource);
      const vars = addVars(data, template);
      return compiled(vars);
    };

  const renderHtml = render('html');
  const renderText = async (
    template: string,
    data: Record<string, unknown>,
  ): Promise<string | null> => {
    const path = mailPath(template, 'text');
    if (!existsSync(path)) {
      return null;
    }
    return render('text')(template, data);
  };

  const renderOptions = async (
    template: string,
    data: Record<string, unknown>,
  ): Promise<MailOptions> => {
    const msg = getMessageConfig(template);
    const defaultFrom = configString('mail:defaultFrom', '');
    const defaultFromName = configString('mail:defaultFromName', '');
    const defaultSubject = configString('mail:defaultSubject', '');

    const fromAddress = msg.from.trim() || defaultFrom;
    const from =
      fromAddress !== ''
        ? msg.fromName.trim() || defaultFromName
          ? {
              name: msg.fromName.trim() || defaultFromName,
              address: fromAddress,
            }
          : fromAddress
        : undefined;

    const toAddress = msg.to.trim();
    const to: MailOptions['to'] | undefined =
      toAddress !== ''
        ? msg.toName.trim()
          ? { name: msg.toName.trim(), address: toAddress }
          : toAddress
        : undefined;

    const subject = (msg.subject.trim() || defaultSubject).trim();
    if (!from || !to || !subject) {
      throw new Error(
        `Missing mail:messages:${template} config (from, to, subject required)`,
      );
    }
    const [html, text] = await Promise.all([
      renderHtml(template, data),
      renderText(template, data),
    ]);
    const resolvedFrom = from as MailOptions['from'];
    const resolvedTo = to as MailOptions['to'];
    const mailOptions: MailOptions = {
      from: resolvedFrom,
      to: resolvedTo,
      subject,
      html: html || undefined,
      text: text ?? undefined,
    };
    log.debug(`Parsed mail message to be sent: ${JSON.stringify(mailOptions)}`);
    return mailOptions;
  };

  const send = async (
    template: string,
    data: Record<string, unknown>,
  ): Promise<void> => {
    const mailOptions = await renderOptions(template, data);
    const payload: nodemailer.SendMailOptions = {
      from: mailOptions.from,
      to: mailOptions.to,
      subject: mailOptions.subject,
      html: mailOptions.html ?? undefined,
      text: mailOptions.text ?? undefined,
    };
    return new Promise((resolve, reject) => {
      transport.sendMail(payload, (err: Error | null, info) => {
        log.debug(`Mailer response: err=${err}, info=${JSON.stringify(info)}`);
        if (err) {
          return reject(err);
        }
        return resolve();
      });
    });
  };

  return {
    render: renderHtml,
    renderHtml,
    renderText,
    renderOptions,
    send,
  };
};
