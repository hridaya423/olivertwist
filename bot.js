const { App } = require('@slack/bolt');
const SimpleJsonDB = require('simple-json-db');
const axios = require('axios');
const cron = require('node-cron');
require('dotenv').config();
const db = new SimpleJsonDB('storage.json');
const WAKATIME_API_KEY = process.env.WAKATIME_API_KEY;
const PERSONAL_CHANNEL = process.env.PERSONAL_CHANNEL_ID;
const PRODUCT_HUNT_API_KEY = process.env.PRODUCT_HUNT_API_KEY;

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN
});

const commands = {
  todo: handleTodo,
  remind: handleReminder,
  poll: handlePoll,
  define: handleDefinition,
  gif: handleGif,
  timer: handleTimer,
  search: handleSearch,
  stats: handleStats,
};

app.event('app_mention', async ({ event, say }) => {
  const text = event.text.toLowerCase();
  const userId = event.user;
  
  logInteraction(userId, text);
  
  const command = Object.keys(commands).find(cmd => text.includes(cmd));
  
  if (command) {
    await commands[command](text, userId, say);
  } else if (text.includes('help')) {
    await showHelp(userId, say);
  } else {
    await say(getRandomResponse(userId));
  }
});

async function fetchProductHuntTrending() {
  try {
    const response = await axios({
      method: 'post',
      url: 'https://api.producthunt.com/v2/api/graphql',
      headers: {
        'Authorization': `Bearer ${PRODUCT_HUNT_API_KEY}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      data: {
        query: `
          {
            posts(first: 5) {
              edges {
                node {
                  name
                  tagline
                  url
                  votesCount
                  topics {
                    edges {
                      node {
                        name
                      }
                    }
                  }
                }
              }
            }
          }
        `
      }
    });

    if (!response.data?.data?.posts?.edges) {
      console.error('Unexpected Product Hunt response format:', response.data);
      return [];
    }

    return response.data.data.posts.edges
      .filter(edge => {
        const topics = edge.node.topics.edges.map(t => t.node.name.toLowerCase());
        return topics.some(t => 
          t.includes('developer') || 
          t.includes('tech') || 
          t.includes('programming') ||
          t.includes('software')
        );
      })
      .map(edge => ({
        name: edge.node.name,
        description: edge.node.tagline,
        url: edge.node.url,
        votes: edge.node.votesCount
      }));
  } catch (error) {
    console.error('Error fetching Product Hunt data:', error.response?.data || error.message);
    return [];
  }
}


async function fetchDevToArticles() {
  try {
    const response = await axios.get('https://dev.to/api/articles', {
      params: {
        top: 5,
        per_page: 5
      }
    });

    return response.data.map(article => ({
      title: article.title,
      url: article.url,
      reactions: article.public_reactions_count,
      tags: article.tag_list
    }));
  } catch (error) {
    console.error('Error fetching Dev.to articles:', error.response?.data || error.message);
    return [];
  }
}

async function generateDailyDigest() {
  const [productHuntProducts, devToArticles] = await Promise.all([
    fetchProductHuntTrending().catch(() => []),
    fetchDevToArticles().catch(() => [])
  ]);

  const intro = [
    "Good morning, dear developer! *Adjusts spectacles* I've scoured the digital streets for the finest discoveries!",
    "*Polishing monocle* Behold the marvels I've discovered in today's technological gazette!",
    "*Straightens bow tie* By my calculations, these are today's most intriguing developments!",
    "Most splendid morning! Allow me to present today's technological wonders!",
    "What fascinating discoveries await in today's digest! *Adjusts waistcoat excitedly*"
  ];

  let message = `${intro[Math.floor(Math.random() * intro.length)]}\n\n`;

  if (productHuntProducts.length > 0) {
    message += "🏹 *Today's Most Ingenious Developer Tools & Products*\n";
    productHuntProducts.forEach(product => {
      message += `• <${product.url}|${product.name}> - ${product.description} (${product.votes} votes)\n`;
    });
    message += "\n";
  }

  if (devToArticles.length > 0) {
    message += "📚 *Most Engaging Developer Articles*\n";
    devToArticles.forEach(article => {
      message += `• <${article.url}|${article.title}> (${article.reactions} reactions)\n`;
    });
    message += "\n";
  }

  message += "Do let me know if you'd like to learn more about any of these marvels! *Tips hat* 🎩";
  return message;
}



async function handleTodo(text, userId, say) {
  if (text.includes('add')) {
    const priority = text.match(/!(high|medium|low)/) ? text.match(/!(high|medium|low)/)[1] : 'medium';
    const category = text.match(/#(\w+)/) ? text.match(/#(\w+)/)[1] : 'general';
    
    let todoText = text.split('todo add ')[1];
    if (!todoText) {
      await say("I'm afraid I didn't catch what todo to add, sir!");
      return;
    }
    
    todoText = todoText
      .replace(/!(high|medium|low)/, '')
      .replace(/#\w+/, '')
      .trim();
    
    const todos = db.get('todos') || [];
    todos.push({
      id: Date.now().toString(),
      userId,
      task: todoText,
      priority,
      category,
      done: false,
      created: new Date().toISOString()
    });
    
    db.set('todos', todos);
    await say(`Please sir, I've added to your ${category} todos with ${priority} priority: ${todoText} ✅`);
  
  } else if (text.includes('done')) {
    const todoId = text.split('done ')[1]?.trim();
    if (!todoId) {
      await say("Which todo shall I mark complete, sir? Please provide the number from the list.");
      return;
    }
    
    const todos = db.get('todos') || [];
    const todoIndex = todos.findIndex(t => t.id === todoId && t.userId === userId);
    
    if (todoIndex !== -1) {
      todos[todoIndex].done = true;
      todos[todoIndex].completedAt = new Date().toISOString();
      db.set('todos', todos);
      await say(`Splendid progress! I've marked "${todos[todoIndex].task}" as complete! 🎉`);
    } else {
      await say("I'm terribly sorry, but I couldn't find that todo in your list.");
    }
  
  } else if (text.includes('list')) {
    const todos = db.get('todos') || [];
    const userTodos = todos.filter(todo => todo.userId === userId && !todo.done);
    
    if (userTodos.length > 0) {
      const grouped = userTodos.reduce((acc, todo) => {
        if (!acc[todo.category]) acc[todo.category] = [];
        acc[todo.category].push(`• [${todo.priority}] ${todo.task} (ID: ${todo.id})`);
        return acc;
      }, {});
      
      let message = "Begging your pardon, here are your current tasks:\n";
      for (const [category, tasks] of Object.entries(grouped)) {
        message += `\n*${category}*:\n${tasks.join('\n')}`;
      }
      message += "\n\nTo mark a todo as done, say `@Oliver Twist todo done <ID>`";
      await say(message);
    } else {
      await say("Why, you've no tasks at all, sir! As free as a bird, you are! 🎉");
    }
  }
}

async function handleReminder(text, userId, say) {
  const reminderText = text.split('remind ')[1];
  const timeMatch = reminderText.match(/in (\d+) (minutes?|hours?|days?)/);
  
  if (timeMatch) {
    const [_, amount, unit] = timeMatch;
    const milliseconds = {
      minute: 60000,
      hour: 3600000,
      day: 86400000
    }[unit.replace('s', '')] * parseInt(amount);
    
    const reminder = {
      userId,
      text: reminderText.split(' in ')[0],
      time: new Date(Date.now() + milliseconds).toISOString()
    };
    
    const reminders = db.get('reminders') || [];
    reminders.push(reminder);
    db.set('reminders', reminders);
    
    setTimeout(async () => {
      await say(`🔔 Begging your pardon, <@${userId}>, but you asked me to remind you about: ${reminder.text}`);
    }, milliseconds);
    
    await say(`Consider it done, sir! I shall remind you about "${reminder.text}" in ${amount} ${unit}. As punctual as Mr. Brownlow, I am!`);
  }
}

async function handlePoll(text, userId, say) {
  const question = text.split('poll ')[1]?.split('?')[0];
  if (!question) {
    await say("I'm afraid I need a question for the poll, sir!");
    return;
  }
  
  const options = text.split('?')[1]?.split(',').map(o => o.trim()).filter(Boolean) || ['Yes', 'No'];
  
  const blocks = [
    {
      type: "section",
      text: { type: "mrkdwn", text: `*Poll from <@${userId}>:* ${question}?` }
    },
    ...options.map((option, index) => ({
      type: "section",
      text: { type: "mrkdwn", text: `${index + 1}. ${option} (0 votes)` },
      accessory: {
        type: "button",
        text: { type: "plain_text", text: "Vote", emoji: true },
        value: `${index}`,
        action_id: `vote_${index}`
      }
    }))
  ];
  
  const polls = db.get('polls') || [];
  const pollId = Date.now().toString();
  polls.push({
    id: pollId,
    question,
    options,
    votes: options.map(() => []),
    created: new Date().toISOString()
  });
  db.set('polls', polls);
  
  await say({ blocks });
}
app.action(/^vote_\d+$/, async ({ action, body, ack, say }) => {
  await ack();
  
  const polls = db.get('polls') || [];
  const pollId = body.message.ts;
  const optionIndex = parseInt(action.value);
  const userId = body.user.id;
  
  const poll = polls.find(p => p.id === pollId);
  if (poll) {
    poll.votes.forEach(votes => {
      const index = votes.indexOf(userId);
      if (index !== -1) votes.splice(index, 1);
    });
    
    poll.votes[optionIndex].push(userId);
    db.set('polls', polls);
    
    const blocks = body.message.blocks.map((block, index) => {
      if (index === 0) return block;
      const voteCount = poll.votes[index - 1].length;
      return {
        ...block,
        text: {
          ...block.text,
          text: `${index}. ${poll.options[index - 1]} (${voteCount} votes)`
        }
      };
    });
    
    await app.client.chat.update({
      token: process.env.SLACK_BOT_TOKEN,
      channel: body.channel.id,
      ts: body.message.ts,
      blocks
    });
  }
});

async function handleDefinition(text, userId, say) {
  const word = text.split('define ')[1]?.trim();
  if (!word) {
    await say("I'm afraid I need a word to look up, sir!");
    return;
  }
  
  try {
    const response = await axios.get(`https://api.dictionaryapi.dev/api/v2/entries/en/${word}`);
    const definition = response.data[0].meanings[0].definitions[0].definition;
    await say(`*${word}*, you ask? Why, that would be: ${definition}`);
  } catch (error) {
    await say(`Begging your pardon, but I'm not familiar with the word "${word}". Perhaps Mr. Bumble would know?`);
  }
}

async function handleGif(text, userId, say) {
  if (!process.env.GIPHY_API_KEY) {
    await say("I'm afraid my picture-finding abilities are rather limited at present, sir.");
    return;
  }

  const searchTerm = text.split('gif ')[1]?.trim();
  if (!searchTerm) {
    await say("I need something to search for, sir! What kind of gif would you like?");
    return;
  }
  try {
    const response = await axios.get(
      `https://api.giphy.com/v1/gifs/search?api_key=${process.env.GIPHY_API_KEY}&q=${searchTerm}&limit=1`
    );
    const gifUrl = response.data.data[0].images.original.url;
    await say(`Why, look what I found in my pocket! ${gifUrl}`);
  } catch (error) {
    await say(`Terribly sorry, but I couldn't find a moving picture of "${searchTerm}". The Artful Dodger must have pinched it!`);
  }
}

async function handleTimer(text, userId, say) {
  const timeMatch = text.match(/timer\s+(\d+)/);
  const minutes = timeMatch ? parseInt(timeMatch[1]) : null;
  
  if (!minutes) {
    await say("I'm afraid I need a number of minutes to count, sir!");
    return;
  }
  
  await say(`⏱ Consider it done! I shall count exactly ${minutes} minutes for you, as precise as Big Ben himself!`);
  
  const timers = db.get('timers') || [];
  timers.push({
    userId,
    minutes,
    endTime: new Date(Date.now() + minutes * 60000).toISOString(),
    notified: false
  });
  db.set('timers', timers);
}
async function handleSearch(text, userId, say) {
  const query = text.split('search ')[1]?.trim();
  if (!query) {
    await say("What shall I search for, sir?");
    return;
  }

  try {
    const searchResponse = await axios.get('https://en.wikipedia.org/w/api.php', {
      params: {
        action: 'query',
        list: 'search',
        srsearch: query,
        format: 'json',
        origin: '*',
        utf8: '',
        srlimit: 3
      }
    });

    const results = searchResponse.data.query.search;
    
    if (results.length === 0) {
      await say(`I've searched high and low through London's finest encyclopedias, but I'm afraid I found nothing about "${query}", sir!`);
      return;
    }

    const pageId = results[0].pageid;
    const extractResponse = await axios.get('https://en.wikipedia.org/w/api.php', {
      params: {
        action: 'query',
        prop: 'extracts',
        exintro: true,
        explaintext: true,
        pageids: pageId,
        format: 'json',
        origin: '*'
      }
    });

    const page = extractResponse.data.query.pages[pageId];
    const extract = page.extract.split('\n')[0];
    
    let response = `📚 *${results[0].title}*\n${extract}\n\n`;
    
    if (results.length > 1) {
      response += "*Other findings you might fancy:*\n";
      for (let i = 1; i < results.length; i++) {
        response += `• ${results[i].title}\n`;
      }
    }
    
    response += `\nSource: https://en.wikipedia.org/wiki/${encodeURIComponent(results[0].title)}`;
    
    await say(response);

  } catch (error) {
    console.error('Search error:', error);
    await say(`Most terribly sorry, sir, but I've encountered a spot of trouble with my research. Perhaps we could try again in a moment? 🎩`);
  }
}

async function handleStats(text, userId, say) {
  const interactions = db.get('interactions') || [];
  const userInteractions = interactions.filter(i => i.userId === userId);
  
  const stats = {
    totalCommands: userInteractions.length,
    mostUsedCommand: getMostUsedCommand(userInteractions),
    todosCompleted: getTodosCompleted(userId),
    remindersSet: getRemindersSet(userId)
  };
  
  await say(`📊 Your ledger shows:\n• Commands issued: ${stats.totalCommands}\n• Most frequent request: ${stats.mostUsedCommand}\n• Tasks completed: ${stats.todosCompleted}\n• Reminders set: ${stats.remindersSet}\n\nQuite the productive member of society, you are!`);
}

function logInteraction(userId, text) {
  const interactions = db.get('interactions') || [];
  interactions.push({
    userId,
    text,
    timestamp: new Date().toISOString()
  });
  db.set('interactions', interactions);
}

function getRandomResponse(userId) {
  const responses = [
    `Please, sir, <@${userId}>, might I assist you? Simply say "@Oliver Twist help"!`,
    `Good day to you, <@${userId}>! Could you spare a moment to say "@Oliver Twist help"?`,
    `Begging your pardon, <@${userId}>, but might I be of service? Do say "@Oliver Twist help"!`,
    `At your service, <@${userId}>! Though a mere orphan boy, I know many tricks - just say "@Oliver Twist help"!`,
    `*Tugging gently at your sleeve* Pardon me, <@${userId}>, but might you need assistance? "@Oliver Twist help" is all you need say!`,
    `*Adjusts cap nervously* Begging your pardon, <@${userId}>, but I've quite a repertoire of useful skills! "@Oliver Twist help" will show you!`,
    `Oh! <@${userId}>! What fortunate timing! Might I interest you in my services? "@Oliver Twist help" will tell all!`,
    `*Straightens worn waistcoat* At your disposal, <@${userId}>! A quick "@Oliver Twist help" will show you my capabilities!`,
    `Consider me your humble servant, <@${userId}>! Just say "@Oliver Twist help" and I shall demonstrate my worth!`,
    `*Polishes a worn pocket watch* Perfect timing, <@${userId}>! Shall I show you how I might be of service? "@Oliver Twist help"!`,
    `*Adjusts threadbare collar* Good day, <@${userId}>! Might I show you my repertoire of services with "@Oliver Twist help"?`,
    `*Clutches cap earnestly* What splendid timing, <@${userId}>! Do let me show you how I can help with "@Oliver Twist help"!`
  ];
  return responses[Math.floor(Math.random() * responses.length)];
}

function getMostUsedCommand(interactions) {
  const commandList = ['todo', 'remind', 'poll', 'define', 'gif', 'timer', 'search', 'stats'];
  const commands = interactions.map(i => {
    const command = commandList.find(cmd => i.text.includes(cmd));
    return command || 'chat';
  });
  
  return commands.reduce((a, b) => (
    commands.filter(v => v === a).length >= commands.filter(v => v === b).length ? a : b
  ), commands[0] || 'none');
}

function getTodosCompleted(userId) {
  const todos = db.get('todos') || [];
  return todos.filter(todo => todo.userId === userId && todo.done).length;
}

function getRemindersSet(userId) {
  const reminders = db.get('reminders') || [];
  return reminders.filter(reminder => reminder.userId === userId).length;
}

let lastProject = '';
let lastLanguage = '';

async function checkWakaTime() {
  try {
    if (!WAKATIME_API_KEY) {
      console.log('WakaTime API key not configured');
      return;
    }

    const apiKey = Buffer.from(WAKATIME_API_KEY).toString('base64');
    
    const response = await axios.get('https://waka.hackclub.com/api/v1/users/current/statusbar/today', {
      headers: {
        'Authorization': `Basic ${apiKey}`
      }
    });

    const responseData = response.data.data;
    
    const currentData = {
      project: null,
      projectTime: null,
      language: null,
      languageTime: null
    };

    if (responseData.projects && responseData.projects.length > 0) {
      const activeProject = responseData.projects.reduce((prev, current) => 
        (prev.total_seconds > current.total_seconds) ? prev : current
      );
      
      if (activeProject && activeProject.total_seconds > 0) {
        currentData.project = activeProject.name;
        currentData.projectTime = {
          hours: Math.floor(activeProject.total_seconds / 3600),
          minutes: Math.floor((activeProject.total_seconds % 3600) / 60)
        };
      }
    }

    if (responseData.languages && responseData.languages.length > 0) {
      const activeLanguage = responseData.languages.reduce((prev, current) => 
        (prev.total_seconds > current.total_seconds) ? prev : current
      );
      
      if (activeLanguage && activeLanguage.total_seconds > 0) {
        currentData.language = activeLanguage.name;
        currentData.languageTime = {
          hours: Math.floor(activeLanguage.total_seconds / 3600),
          minutes: Math.floor((activeLanguage.total_seconds % 3600) / 60)
        };
      }
    }

    
    const formatTime = (time) => {
      if (time.hours > 0) {
        return `${time.hours}h ${time.minutes}m`;
      }
      return `${time.minutes}m`;
    };
    
    if (currentData.project && 
        currentData.language && 
        (currentData.project !== lastProject || currentData.language !== lastLanguage)) {
      
      lastProject = currentData.project;
      lastLanguage = currentData.language;
      
      const projectTime = formatTime(currentData.projectTime);
      const languageTime = formatTime(currentData.languageTime);
      
      const codingMessages = [
        `Observing some fine ${currentData.language} craftsmanship (${languageTime}) in ${currentData.project} (${projectTime})! Most industrious! 🎩`,
        `Some splendid ${currentData.language} work (${languageTime}) happening in ${currentData.project} (${projectTime})! 🧐`,
        `*Adjusts spectacles* Writing ${currentData.language} (${languageTime}) in ${currentData.project} (${projectTime})! Mr. Brownlow would be most impressed! ⌨️`,
        `${currentData.project} (${projectTime}) being enhanced with ${currentData.language} (${languageTime})! What a marvel of modern engineering! 💻`,
        `Ah! ${projectTime} of progress on ${currentData.project} using ${currentData.language} (${languageTime})! Like music to my ears! 🎵`,
        `By George! ${languageTime} of ${currentData.language} work in ${currentData.project}! Most sophisticated! 🎩`,
        `*Polishes monocle* What's this? ${projectTime} spent on ${currentData.project} with ${currentData.language}! How splendid! ✨`,
        `Great Scott! ${languageTime} of ${currentData.language} development in ${currentData.project} (${projectTime})! The future is now! 🚀`,
        `*Adjusts cravat* Most impressive ${currentData.language} work (${languageTime}) in ${currentData.project}! Such elegance! 🎭`,
        `Witnessing masterful ${currentData.language} craftsmanship for ${languageTime} in ${currentData.project} (${projectTime})! Simply extraordinary! ⚡`
      ];
      
      if (PERSONAL_CHANNEL) {
        const selectedMessage = codingMessages[Math.floor(Math.random() * codingMessages.length)];
        
        await app.client.chat.postMessage({
          token: process.env.SLACK_BOT_TOKEN,
          channel: PERSONAL_CHANNEL,
          text: selectedMessage
        });
        console.log('Message sent successfully');
      } else {
        console.log('No PERSONAL_CHANNEL configured');
      }
    }
  } catch (error) {
    console.error('Error checking WakaTime:', error.message);
    if (error.response) {
      console.error('WakaTime API Response:', error.response.data);
    }
  }
}

cron.schedule('*/30 * * * *', checkWakaTime);

cron.schedule('0 8 * * *', async () => {
  try {
    if (PERSONAL_CHANNEL) {
      const digest = await generateDailyDigest();
      await app.client.chat.postMessage({
        token: process.env.SLACK_BOT_TOKEN,
        channel: PERSONAL_CHANNEL,
        text: digest,
        unfurl_links: false
      });
      console.log('Daily digest sent successfully');
    }
  } catch (error) {
    console.error('Error sending daily digest:', error);
    if (PERSONAL_CHANNEL) {
      try {
        await app.client.chat.postMessage({
          token: process.env.SLACK_BOT_TOKEN,
          channel: PERSONAL_CHANNEL,
          text: "*Adjusts cap apologetically* I do beg your pardon, but I've encountered some difficulty with today's digest. I shall try again shortly! 🎩"
        });
      } catch (notifyError) {
        console.error('Error sending error notification:', notifyError);
      }
    }
  }
}, {
  timezone: 'GMT'
});

cron.schedule('*/10 * * * *', async () => {
  const randomMessages = [
    "Any tasks I might assist with, good people?",
    "Please, might I be of service to anyone?",
    "*Adjusts cap* Always ready to help, I am!",
    "Consider me at your disposal, should you need anything!",
    "Begging your pardon, but I'm here to help if needed!",
    "*Dusts off jacket* Might anyone require assistance today?",
    "By my threadbare cap, I'd be delighted to help!",
    "*Practices best curtsy* At your service, good folk!",
    "What a fine day to be of assistance! Might anyone need help?",
    "*Straightens worn bow tie* Ready and willing to serve, as always!",
    "Oh! How wonderful to see you all! Might I be of any help?",
    "*Polishes single brass button* Whatever the task, I'm here to assist!",
    "*Adjusts patched waistcoat* At your service, as always!",
    "Might there be any tasks requiring attention? Do say the word!",
    "*Smooths down worn lapels* Ready and eager to assist, as ever!"
  ];

  try {
    if (PERSONAL_CHANNEL) {
      const randomMessage = randomMessages[Math.floor(Math.random() * randomMessages.length)];
      await app.client.chat.postMessage({
        token: process.env.SLACK_BOT_TOKEN,
        channel: PERSONAL_CHANNEL,
        text: randomMessage
      });
    }
  } catch (error) {
    console.error('Error sending random message:', error);
  }
}); 
cron.schedule('* * * * *', async () => {
  const timers = db.get('timers') || [];
  const now = new Date();
  
  const dueTimers = timers.filter(timer => 
    new Date(timer.endTime) <= now && !timer.notified
  );
  
  for (const timer of dueTimers) {
    await app.client.chat.postMessage({
      token: process.env.SLACK_BOT_TOKEN,
      channel: timer.userId,
      text: `⏰ Begging your pardon <@${timer.userId}>, but your ${timer.minutes} minutes have passed! Time flies in the workhouse!`
    });
    timer.notified = true;
  }
  
  const activeTimers = timers.filter(timer => 
    new Date(timer.endTime) > now || !timer.notified
  );
  db.set('timers', activeTimers);
});
cron.schedule('* * * * *', async () => {
  const reminders = db.get('reminders') || [];
  const now = new Date();
  
  const dueReminders = reminders.filter(reminder => 
    new Date(reminder.time) <= now && !reminder.sent
  );
  
  for (const reminder of dueReminders) {
    await app.client.chat.postMessage({
      token: process.env.SLACK_BOT_TOKEN,
      channel: reminder.userId,
      text: `🔔 Begging your pardon, but you asked me to remind you about: ${reminder.text}`
    });
    reminder.sent = true;
  }
  
  db.set('reminders', reminders);
});
async function showHelp(userId, say) {
  const helpText = 
    `Please, sir or madam <@${userId}>, allow me to present my humble services:\n\n` +
    "*Your Task Ledger*\n" +
    "• `@Oliver Twist todo add [task] !priority #category` - I shall note down your task (priorities: !high, !medium, !low)\n" +
    "• `@Oliver Twist todo list` - I shall recite your outstanding tasks\n" +
    "• `@Oliver Twist todo done [ID]` - I shall mark your task as complete\n\n" +
    "*Time Keeping*\n" +
    "• `@Oliver Twist remind [task] in [X] minutes/hours/days` - I shall remember to remind you\n" +
    "• `@Oliver Twist timer [X]` - I shall count the minutes\n\n" +
    "*Knowledge from the Streets*\n" +
    "• `@Oliver Twist define [word]` - I shall consult Mr. Brownlow's dictionary\n" +
    "• `@Oliver Twist search [query]` - I shall ask around London\n\n" +
    "*Entertainment*\n" +
    "• `@Oliver Twist poll [question]? [option1], [option2], ...` - I shall gather opinions\n" +
    "• `@Oliver Twist gif [search]` - I shall find a moving picture\n\n" +
    "*Your Records*\n" +
    "• `@Oliver Twist stats` - I shall report your activities\n\n" +
    "Please sir, I aim to serve with the utmost efficiency! 🎩";
    
  await say(helpText);
}
(async () => {
  await app.start();
  console.log('⚡️ Oliver Twist is at your service!');
})();