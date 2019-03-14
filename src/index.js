#!/usr/bin/env node

const inquirer = require("inquirer");
const mri = require("mri");
const logUpdate = require("log-update");
const chalk = require("chalk");
const hasAnsi = require("has-ansi");
const ora = require("ora");
const moment = require("moment");
const ms = require("ms");
const updateNotifier = require("update-notifier");
const pkg = require("../package.json");
const Client = require("instagram-private-api").V1;

let device, storage;

async function main(_argv) {
  const argv = mri(_argv, {
    string: ["username", "password"],
    boolean: ["version", "help", "persist"],
    alias: {
      username: "u",
      password: "p",
      interval: "i",
      version:  "v",
      help:     "h",
      persist:  "s"
    }
  });
  console.log(chalk.dim(`igdm-cli v${pkg.version}`));
  const notifier = updateNotifier({ pkg });
  notifier.notify();
  if (argv.version) process.exit(0);
  if (argv.help) {
    console.log(`
Usage:
    $  igdm
    $  igdm [-h] | [-v] | [-s] | [-u <username>] [-p <password>] [-i <polling interval>]
    $  igdm [--help] | [--version] | [--persist] | [--username=<username>] [--password=<password>] [--interval=<polling interval>]

Options:
    -h, --help                  Show this screen.
    -v, --version               Show version.
    -s, --persist               Save session in disk.
    -u, --username <username>   Set Instagram username. [default: will prompt]
    -p, --password <password>   Set Instagram password. [default: will prompt]
    -i, --interval <interval>   Set polling interval (seconds) in chat rooms [default: 5]

Notes:
    In chatroom mode, exit by entering '/end'. Manually refresh the room by entering '/refresh'.
    `);
    process.exit(0);
  }

  if (argv.interval && typeof argv.interval !== "number")
    throw new Error(
      `<interval> argument must be a number. Instead it's a ${typeof argv.interval}`
    );
  const getMsgPayload = msgToSend => msgToSend.join("");
  const renderInput = async ({ items, title, message }) => {
    const threadItemsStr = items.length
      ? items
          .sort((a, b) => a.created - b.created)
          .map(i => parseMessageString(i))
          .join("\n")
      : "There are no messages yet.";
    logUpdate(
      `${threadItemsStr}${
        pending.length > 0 ? `\n${pending.join("\n")}` : ""
      }\n\n${chalk.dim("`/refresh` to refresh chat")}\n${chalk.dim(
        "`/end` to end chat"
      )}\nReply to ${title} ${chalk.green("›")} ${getMsgPayload(message)}`
    );
  };

  let _username;
  if (!argv.username) {
    const { username } = await inquirer.prompt({
      name: "username",
      message: "Instagram Username: "
    });
    _username = username;
  } else {
    _username = argv.username;
  }

  device = new Client.Device(`instagram.com/${_username}`);
  storage = argv.persist
    ? new Client.CookieFileStorage(
        __dirname + ("/ig-cookie." + _username + ".json")
      )
    : new Client.CookieMemoryStorage();

  let _password;
  if (!argv.password) {
    const { password } = await inquirer.prompt({
      name: "password",
      message: "Instagram Password: ",
      type: "password"
    });
    _password = password;
  } else {
    _password = argv.password;
  }

  const loginSpinner = ora(`Logging in as ${_username}`).start();

  let session;

  try {
    session = await Client.Session.create(
      device,
      storage,
      _username,
      _password
    );
  } catch (e) {
    // Errors logging in
    if (e.name == "AuthenticationError") {
      loginSpinner.fail(`Can't log in. ${e.message}`);
    }
    process.exit(1);
  }

  loginSpinner.succeed(`You are logged in as ${_username}`);

  const userAccountId = await storage.getAccountId();

  let mainLoop = true;
  let instagramAccounts = {};

  const parseMessageString = threadItem => {
    const senderId = threadItem.userId;
    const senderUsername =
      senderId === userAccountId
        ? chalk.cyan("You")
        : (instagramAccounts[senderId] &&
            chalk.magenta(instagramAccounts[senderId].username)) ||
          chalk.red("A User");

    const payloadType = threadItem.itemType;
    let payloadMessage;
    const payloadCreated = threadItem.created;
    switch (payloadType) {
      case "text":
        payloadMessage = `"${threadItem.text}"`;
        break;
      case "media":
        payloadMessage = JSON.stringify(threadItem.media);
        payloadMessage = `[media] › ${chalk.underline(
          threadItem.media[0].url
        )}`;
        break;
      case "like":
        payloadMessage = "♥";
        break;
      default:
        payloadMessage = `[a non-text message of type ${payloadType}]`;
        break;
    }
    return `${senderUsername}: ${chalk.white(payloadMessage)} ${chalk.dim(
      `[${moment(payloadCreated).fromNow()}]`
    )}`;
  };

  let ClientInbox;
  let inboxBuffer = [];
  let pending = [];

  const getOlder = async () =>
    (await ClientInbox.get()).map(thread =>
      thread.parseParams(thread.getParams())
    );
  const getAllOlder = async () =>
    (await ClientInbox.all()).map(thread =>
      thread.parseParams(thread.getParams())
    );
  const refreshInbox = async () => {
    ClientInbox = await new Client.Feed.Inbox(session);
    inboxBuffer = await getOlder();
  };
  const fetchOlderToBuffer = async () => {
    inboxBuffer = [...inboxBuffer, ...(await getOlder())];
  };
  const fetchAllToBuffer = async () => {
    inboxBuffer = [...inboxBuffer, ...(await getAllOlder())];
  };

  const createChoicesFromBuffer = () => {
    return (
      inboxBuffer
        // .filter(m => !m.threadTitle.includes("")) // CUSTOM FILTER
        .filter(m => m.accounts.length)
        .map(m => ({
          name: `${chalk.underline(
            `[${m.threadTitle}]`
          )} - ${parseMessageString(m.items[0])}`,
          value: m.threadId,
          short: m.threadTitle
        }))
    );
  };

  const inboxSpinner = ora("Opening inbox").start();
  inboxSpinner.text = "Fetching recent threads";
  await refreshInbox();
  inboxSpinner.succeed("Recent threads");

  const CHOICE_FETCH_OLDER = {
    name: "Fetch older items",
    value: "CHOICE_FETCH_OLDER",
    short: "Fetch older items"
  };
  const CHOICE_FETCH_ALL = {
    name: "Fetch all items",
    value: "CHOICE_FETCH_ALL",
    short: "Fetch all items"
  };
  const CHOICE_REFRESH = {
    name: "Refresh inbox",
    value: "CHOICE_REFRESH",
    short: "Refresh inbox"
  };

  while (mainLoop) {
    inboxBuffer.forEach(m =>
      m.accounts.forEach(a => {
        if (!instagramAccounts[a.id]) {
          instagramAccounts[a.id] = a;
        }
      })
    );
    const choices = createChoicesFromBuffer();
    const choicesWithMenu = ClientInbox.isMoreAvailable()
      ? [...choices, CHOICE_FETCH_OLDER, CHOICE_FETCH_ALL, CHOICE_REFRESH]
      : [...choices, CHOICE_REFRESH];

    const { id } = await inquirer.prompt({
      name: "id",
      message: "Inbox threads: ",
      type: "list",
      choices: choicesWithMenu
    });

    let chatLoop = !`${id}`.includes("CHOICE_") ? true : false;
    let thread;

    if (id === CHOICE_FETCH_ALL.value) {
      await fetchAllToBuffer();
    } else if (id === CHOICE_FETCH_OLDER.value) {
      await fetchOlderToBuffer();
    } else if (id === CHOICE_REFRESH.value) {
      await refreshInbox();
    }

    // let thread = await Client.Thread.getById(session, id)
    // console.log(thread.parseParams(thread.getParams()))

    while (chatLoop) {
      let Thread = await Client.Thread.getById(session, id);
      let thread = Thread.parseParams(Thread.getParams());
      let threadTitle = `[${thread.threadTitle}]`;
      let msgToSend = [];

      const updateThread = async () => {
        Thread = await Client.Thread.getById(session, id);
        thread = Thread.parseParams(Thread.getParams());
        renderInput({
          items: thread.items,
          title: threadTitle,
          message: msgToSend
        });
      };
      const interval = ms(`${argv.interval}s`) || ms("5s");
      const threadRefreshInterval = setInterval(updateThread, interval);

      renderInput({
        items: thread.items,
        title: threadTitle,
        message: msgToSend
      });

      await new Promise(resolve => {
        const keypressHandler = async (ch, key = {}) => {
          if (hasAnsi(key.sequence)) return;
          if (key.ctrl && key.name === "c") {
            if (msgToSend.length <= 1) {
              logUpdate();
              // readline.moveCursor(process.stdout, 0, -1);
            }
            process.exit();
          }
          if (key.name === "return" || (key.ctrl && key.name === "u")) {
            const msgPayload = getMsgPayload(msgToSend);
            if (msgToSend.length <= 0) return;
            if (msgPayload === "/end") {
              logUpdate(
                `[*] Ending chat with ${threadTitle}, refreshing inbox.`
              );
              await refreshInbox();
              logUpdate(`[*] Ended chat with ${threadTitle}.`);
              process.stdin.pause();
              process.stdin.removeListener("keypress", keypressHandler);
              chatLoop = false;
              resolve(key);
            } else if (msgPayload === "/refresh") {
              logUpdate("[*] Refreshing");
              process.stdin.pause();
              process.stdin.removeListener("keypress", keypressHandler);
              resolve(key);
            } else {
              msgToSend.length = 0;
              pending.push(
                `You: ${chalk.white(msgPayload)} ${chalk.dim(`[sending...]`)}`
              );
              renderInput({
                items: thread.items,
                title: threadTitle,
                message: msgToSend
              });
              await Thread.broadcastText(msgPayload);
              pending = pending.slice(1);
              updateThread();
            }
          } else if (key.name === "backspace") {
            msgToSend.pop();
            renderInput({
              items: thread.items,
              title: threadTitle,
              message: msgToSend
            });
          } else {
            msgToSend.push(ch);
            renderInput({
              items: thread.items,
              title: threadTitle,
              message: msgToSend
            });
          }
        };
        process.stdin.on("keypress", keypressHandler);
        process.stdin.setRawMode(true);
        process.stdin.resume();
      });
      clearInterval(threadRefreshInterval);
    }
  }
}

main(process.argv).catch(err => {
  console.log(err);
  process.exit(1);
});
