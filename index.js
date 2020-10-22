require('dotenv').config();
const fs = require('fs');
const { App, ExpressReceiver } = require('@slack/bolt');
const FlexSearch = require("flexsearch");
const axios = require('axios');

let paperData = undefined;
let searchIndex = undefined;

const isCacheStale = () => {
  const cacheInfo = fs.statSync('index.cache.json');
  const ageMs = Date.now() - cacheInfo.mtimeMs;
  const ageHours = ageMs / (1000*60*60);
  return ageHours >= 24;
};

const loadCache = () => {
  try {
    if (isCacheStale()) {
      return undefined;
    } else {
      return fs.readFileSync('index.cache.json');
    }
  } catch (e) {
    return undefined;
  }
};

const downloadIndex = async () => {
  const response = await axios.get('https://wg21.link/index.json');
  if (typeof response.data === 'object') {
    return response.data;
  } else {
    return undefined;
  }
};

const updateSearchIndex = () => {
  // 1. We need to convert the JSON object into an array so that FlexSearch can
  // swallow it.
  // 2. Since field search in FlexSearch is sensitive to field reordering
  // (https://github.com/nextapps-de/flexsearch/issues/70), we will merge all the
  // data we intend to search on (paperId, title, author, date) into one string
  // and put it at the top in the 'index' definition.
  // 3. We still want the 'type' field because we can filter results with it.
  // We still want the 'date' field because we sort the results with it.
  // 'paperId' is necessary because FlexSearch index needs an 'id'.
  const adjustedPaperData = Object.keys(paperData).map(paperId => {
    const paper = paperData[paperId];
    return {
      data: [paperId, paper.title, paper.author, paper.date].join(' '),
      paperId: paperId,
      type: paper.type,
      date: paper.date
    };
  });

  searchIndex = new FlexSearch({
    tokenize: "strict",
    depth: 1,
    doc: {
      id: "paperId",
      field: {
        data: {},
        paperId: {
          tokenize: "forward"
        },
        type: {},
        date: {}
      }
    }
  });
  searchIndex.add(adjustedPaperData);
};

const initializeIndex = async () => {
  const cache = loadCache();
  if (cache !== undefined) {
    paperData = JSON.parse(cache);
    updateSearchIndex();
    console.log('Loaded index from cache successfully!');
    return;
  }

  const index = await downloadIndex();
  if (index !== undefined) {
    paperData = index;
    updateSearchIndex();
    fs.writeFile('index.cache.json', JSON.stringify(index), () => {});
    console.log('Downloaded index successfully!');
    return;
  }

  console.log('Loading index.json from local file.');
  paperData = JSON.parse(fs.readFileSync('index.json'));
  updateSearchIndex();

};

setInterval(async () => {
  const index = await downloadIndex();
  if (index !== undefined) {
    paperData = index;
    updateSearchIndex();
    fs.writeFile('index.cache.json', JSON.stringify(index), () => {});
    console.log('Downloaded and updated the index successfully!');
  }

  console.log('Failed to download and update the index!');
}, 24*60*60*1000);

const latestFirst = (x, y) => {
  if (x.date === undefined) return 1;
  if (y.date === undefined) return -1;
  const [xyear, xmonth, xday] = x.date.split('-').map(str => parseInt(str, 10));
  const [yyear, ymonth, yday] = y.date.split('-').map(str => parseInt(str, 10));
  if (xyear !== yyear) return yyear < xyear ? -1 : 1;
  if (xmonth !== ymonth) return ymonth < xmonth ? -1 : 1;
  return yday < xday ? -1 : 1;
};

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
  const title = paper.title.replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const author = paper.author === undefined ? '' : ` (by ${paper.author})`;
  const date = paper.date === undefined ? '' : ` (${paper.date})`;
  const issues = paper.issues === undefined ? [] : paper.issues.map(issue => `<${paperData[issue].long_link}|${issue}>`)
  if (paper.github_url !== undefined) {
    issues.push(`<${paper.github_url}|GitHub issue>`);
  }
  const allIssues = issues.length === 0 ? '' : ` (Related: ${issues.join(', ')})`;
  return `<${paper.long_link}|${paperId}:${subgroup} ${title}>${author}${date}${allIssues}`;
};

// We avoid passing { limit: 30 } to FlexSearch because it discards relevant results
// for some reason.
const search = ({ query, type }) => {
  let searchResults = [];
  if (type === undefined) {
    searchResults = searchIndex.search({
      query: query,
      sort: latestFirst
    });
  } else {
    searchResults = searchIndex.search({
      query: query,
      where: { type: type },
      sort: latestFirst
    });
  }
  if (searchResults.length === 0) {
    return 'No results.';
  }
  searchResults = searchResults.slice(0, 30);
  const topResults = searchResults.slice(0, 15);
  const responseText = topResults.map(result => result.paperId)
    .map(makePaperMessage)
    .join('\n') + (searchResults.length <= 15 ? ''
      : ('\nAlso: ' + searchResults.slice(15).map(result => `<${paperData[result.paperId].long_link}|${result.paperId}>`).join(', ')));
  return responseText;
};

const matchPaper = (text) => {
  const result = text.match(/(N\d{4}|[PD]\d{4}(R\d)?|(CWG|EWG|LWG|LEWG|FS)\d{1,4})/i);
  return result === null ? undefined : result[0];
};

const matchPaperInSquareBrackets = (text) => {
  const result = text.match(/\[(N\d{4}|[PD]\d{4}(R\d)?|(CWG|EWG|LWG|LEWG|FS)\d{1,4})\]/i);
  return result === null ? undefined : result[0];
};

const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET
});

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver: receiver
});

// health check
receiver.app.get('/health', (_, res) => {
  res.status(200).send("app is running");
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
        let text = '';
        if (words[1] === 'papers') {
          text = search({ query: words.slice(2).join(' '), type: "paper" });
        } else if (words[1] === 'issues') {
          text = search({ query: words.slice(2).join(' '), type: "issue" });
        } else {
          text = search({ query: words.slice(1).join(' ') });
        }

        await say({
          text: text,
          unfurl_links: false,
          unfurl_media: false,
          thread_ts: event.thread_ts
        });
        return;
      }

      if (words[0] === 'help') {
        await say({
          text: 'Usage: "@npaperbot search [papers|issues|everything]: <keywords>"'
                 + ' or "@npaperbot {Nxxxx|Pxxxx|PxxxxRx|Dxxxx|DxxxxRx|CWGxxx|EWGxxx|LWGxxx|LEWGxxx|FSxxx}..."',
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
  await initializeIndex();
  await app.start(process.env.PORT || 3000);
  console.log('⚡️ Paperbot is running!');
})();

