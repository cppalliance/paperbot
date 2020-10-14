const fs = require('fs');
require('dotenv').config();
const { App } = require('@slack/bolt');

let paperData = JSON.parse(fs.readFileSync('index.json'))

const bot = new App({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  token: process.env.SLACK_BOT_TOKEN
});

const makePaperMessage = (paperId) => {
  const paper = paperData[paperId];
  const subgroup = (paper.subgroup === undefined || paper.subgroup === '') ? '' : ` [${paper.subgroup}]`;
  const author = paper.author === undefined ? '' : ` (by ${paper.author})`;
  const date = paper.date === undefined ? '' : ` (${paper.date})`;
  const issues = paper.issues === undefined ? [] : paper.issues.map(issue => `<https://wg21.link/${issue.toLowerCase()}|${issue}>`)
  if (paper.github_url !== undefined) {
    issues.push(`<${paper.github_url}|GitHub issue>`);
  }
  const allIssues = issues.length === 0 ? '' : ` (Related: ${issues.join(', ')})`;
  return `<${paper.link}|${paperId}:${subgroup} ${paper.title}>${author}${date}${allIssues}`;
};

const findLatestRevision = (paperId) => {
  let revisionFound = false;
  let latestRevision = 0;
  for (let revision = 0;; revision++) {
    let revPaperId = `${paperId}R${revision}`;
    if (paperData[revPaperId] === undefined) {
      break;
    } else {
      revisionFound = true;
      latestRevision = revision;
    }
  }
  if (revisionFound) {
    return `${paperId}R${latestRevision}`;
  } else {
    return undefined;
  }
};

bot.event("app_mention", async ({ context, event }) => {
try {
  console.log(event)
  const messageWords = event.text.split(' ');
  if (messageWords.length < 2) return;
  const command = messageWords[1];
  if (command === 'search') {
    const keywords = messageWords.slice(2).map(word => word.toLowerCase());
    let searchResults = [];
    for (let paperId in paperData) {
      let titleOccurrences = 0;
      let authorOccurrences = 0;
      titleOccurrences = paperData[paperId].title.toLowerCase().split(' ').filter(word => keywords.includes(word)).length;
      if (paperData[paperId].author !== undefined) {
        authorOccurrences = paperData[paperId].author.toLowerCase().split(' ').filter(word => keywords.includes(word)).length;
      }
      const totalOccurrences = titleOccurrences + authorOccurrences;
      if (totalOccurrences > 0) {
        searchResults.push({ occurrences: totalOccurrences, paperId: paperId });
      }
    }
    if (searchResults.length === 0) {
      await bot.client.chat.postMessage({
        token: context.botToken,
        channel: event.channel,
        text: 'No results.'
      });
    } else {
      searchResults.sort((x, y) => y.occurrences < x.occurrences ? -1 : 1);
      searchResults = searchResults.slice(0, 30);
      let topResults = searchResults.slice(0, 15);
      topResults.sort((x, y) => {
        if (paperData[x.paperId].date === undefined) return 1;
        if (paperData[y.paperId].date === undefined) return -1;
        const [xyear, xmonth, xday] = paperData[x.paperId].date.split('-').map(str => parseInt(str));
        const [yyear, ymonth, yday] = paperData[y.paperId].date.split('-').map(str => parseInt(str));
        if (xyear !== yyear) return yyear < xyear ? -1 : 1;
        if (xmonth !== ymonth) return ymonth < xmonth ? -1 : 1;
        return yday < xday ? -1 : 1;
      });
      const responseText = topResults.map(result => result.paperId)
        .map(makePaperMessage)
        .join('\n') + (searchResults.length <= 15 ? ''
          : ('\nAlso: ' + searchResults.slice(15).map(result => `<${paperData[result.paperId].link}|${result.paperId}>`).join(', ')))
      await bot.client.chat.postMessage({
        token: context.botToken,
        channel: event.channel,
        text: responseText
      });
    }
  } else if (command.startsWith('[') && command.endsWith(']')) {
    let paperId = command.slice(1, -1);

    if (paperId.startsWith('P') && paperId.length === 5) {
      paperId = findLatestRevision(paperId);
    }

    if (paperId === undefined || paperData[paperId] === undefined) {
      await bot.client.chat.postMessage({
        token: context.botToken,
        channel: event.channel,
        text: "Sorry, I could not find that paper."
      });
    } else {
      await bot.client.chat.postMessage({
        token: context.botToken,
        channel: event.channel,
        text: makePaperMessage(paperId)
      });
    }
  } else {
    await bot.client.chat.postMessage({
      token: context.botToken,
      channel: event.channel,
      text: "Sorry, I didn't understand that."
    });
  }
} catch (e) {
  console.log('Error occurred:', e);
}
});

bot.message(/\[((P|N)([R0-9])*)\]/, async ({ context, say }) => {
  try {
    let paperId = context.matches[1];

    if (paperId.startsWith('P') && paperId.length === 5) {
      paperId = findLatestRevision(paperId);
    }

    if (paperId === undefined || paperData[paperId] === undefined) {
      // await say("Sorry, I could not find that paper.");
      // or we can fail silently...
    } else {
      // await say(makePaperMessage(paperId));
      await say({
        text: makePaperMessage(paperId),
        unfurl_links: false,
        unfurl_media: false
      });
    }
  } catch (e) {
    console.log('Error occurred:', e);
  }
});

(async () => {
  // Start the app
  await bot.start(process.env.PORT || 3000);

  console.log('⚡️ Bolt app is running!');
})();
