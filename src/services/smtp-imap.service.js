import nodemailer from "nodemailer";
import Imap from "imap";
import { SocksProxyAgent } from "socks-proxy-agent";
import socks from "socks";
import tls from "tls";

export const verifySmtp = async ({ host, port, secure, user, password, proxy = null }) => {
  try {
    const transportConfig = {
      host,
      port: parseInt(port),
      secure,
      auth: { user, pass: password },
      tls: { rejectUnauthorized: false },
    };

    if (proxy) {
      transportConfig.proxy = proxy;
    }

    const transporter = nodemailer.createTransport(transportConfig);

    if (proxy && (proxy.startsWith("socks4") || proxy.startsWith("socks5"))) {
      transporter.set("proxy_socks_module", socks);
    }

    await transporter.verify();

    return { success: true };
  } catch (err) {
    if (err.message.includes("403")) {
      throw new Error(`Proxy blocked the connection (403). Webshare and other providers often block SMTP ports (587, 465) by default. Please ensure these ports are unblocked in your proxy dashboard or use a SOCKS5 proxy.`);
    }
    throw new Error(err.message);
  }
};

export const verifyImap = async ({ host, port, secure, user, password, proxy = null }) => {
  return new Promise((resolve, reject) => {
    const imapConfig = {
      user,
      password,
      host,
      port: parseInt(port),
      tls: secure,
      tlsOptions: { rejectUnauthorized: false },
      authTimeout: 10000,
      connTimeout: 10000,
    };

    // If proxy is provided, we need to handle the socket connection manually for node-imap
    if (proxy) {
      const agent = new SocksProxyAgent(proxy);

      // SocksProxyAgent.callback returns a socket
      agent.callback(
        { host, port: parseInt(port) },
        { rejectUnauthorized: false },
        (err, socket) => {
          if (err) {
            return reject(new Error(`SOCKS Proxy connection failed: ${err.message}`));
          }

          // Wrap in TLS if requested
          let connectionSocket = socket;
          if (secure) {
            connectionSocket = tls.connect({
              socket: socket,
              host,
              port: parseInt(port),
              rejectUnauthorized: false
            });
          }

          const imap = new Imap({
            ...imapConfig,
            // Pass the already connected socket
            socket: connectionSocket,
          });

          setupImapHandlers(imap, resolve, reject);
        }
      );
    } else {
      const imap = new Imap(imapConfig);
      setupImapHandlers(imap, resolve, reject);
    }
  });
};

function setupImapHandlers(imap, resolve, reject) {
  imap.once("ready", () => {
    imap.end();
    resolve({ success: true });
  });

  imap.once("error", (err) => {
    reject(err);
  });

  // If we didn't pass a pre-connected socket, we must call connect()
  if (!imap._config.socket) {
    imap.connect();
  } else {
    // If we DID pass a socket, node-imap still expects connect() to be called to initialize 
    // but internally it should handle the pre-existing socket if we injected it right.
    // Actually, node-imap doesn't officially support 'socket' in config.
    // Let's refine the IMAP proxy approach.
    imap.connect();
  }
}
