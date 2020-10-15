const fs = require('fs');
require('dotenv').config();
const { App } = require('@slack/bolt');

let paperData = JSON.parse(fs.readFileSync('index.json'))

const findPaper = (paperId) => {
  paperId = paperId.toUpperCase();
  if ((paperId.startsWith('P') || paperId.startsWith('D')) && paperId.length === 5) {
    paperId = findLatestRevision(paperId) || paperId;
  }

  if (paperId === undefined || paperData[paperId] === undefined) {
    return 'Sorry, I could not find that paper.';
  } else {
    return makePaperMessage(paperId);
  }
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

const search = (query) => {
  const keywords = query.split(' ').map(word => word.toLowerCase());
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
    return 'No results.';
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
    return responseText;
  }
};

const matchPaper = (text) => {
  const result = text.match(/(N\d{4}|[PD]\d{4}(R\d)?|(CWG|EWG|LWG|LEWG|FS)\d{3})/i);
  return result === null ? undefined : result[0];
};

const matchPaperInSquareBrackets = (text) => {
  const result = text.match(/\[(N\d{4}|[PD]\d{4}(R\d)?|(CWG|EWG|LWG|LEWG|FS)\d{3})\]/i);
  return result === null ? undefined : result[0];
};

const app = new App({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  token: process.env.SLACK_BOT_TOKEN
});

const botMentioned = (messageText, botUserId) => {
  const regex = new RegExp(`^<@${botUserId}>`);
  return messageText.match(regex) !== null;
};

app.message(/.*/, async ({ context, event, say }) => {
  try {
    const mentioned = botMentioned(event.text, context.botUserId);
    let words = [];
    if (mentioned) {
      words = event.text.split(' ').filter(word => word !== '').slice(1);
    } else if (event.channel_type === 'im') {
      words = event.text.split(' ').filter(word => word !== '');
    }
    if (mentioned || event.channel_type === 'im') {
      if (words[0] === 'search') {
        await say({
          text: search(words.slice(1).join(' ')),
          unfurl_links: false,
          unfurl_media: false,
          thread_ts: event.thread_ts
        });
        return;
      }

      let paperId = matchPaperInSquareBrackets(words[0]);
      if (paperId !== undefined) {
        await say({
          text: findPaper(words[0].slice(1, -1)),
          unfurl_links: false,
          unfurl_media: false,
          thread_ts: event.thread_ts
        });
        return;
      }

      paperId = matchPaper(words[0]);
      if (paperId !== undefined) {
        await say({
          text: findPaper(words[0]),
          unfurl_links: false,
          unfurl_media: false,
          thread_ts: event.thread_ts
        });
        return;
      }
    } else {
      const paperId = matchPaperInSquareBrackets(event.text);
      if (paperId !== undefined) {
        await say({
          text: findPaper(paperId.slice(1, -1)),
          unfurl_links: false,
          unfurl_media: false,
          thread_ts: event.thread_ts
        });
      }
    }
  } catch (e) {
    console.log('Error occurred:', e);
  }
});

(async () => {
  await app.start(process.env.PORT || 3000);
  console.log('⚡️ Paperbot is running!');
})();
