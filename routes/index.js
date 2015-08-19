var express = require('express');
var Promise = require('bluebird');
var request = require('request-promise');
var env = process.env;
var router = express.Router();
var baseURL = 'https://slack.com/api/';
var config = require('../config');
var slackToken = env.SLACK_TOKEN || config.slackToken;
var slackAPIKey = env.SLACK_API_KEY || config.slackAPIKey;
var redisOptions = {
  port: env.REDIS_PORT || 6379,
  host: env.REDIS_HOST || '127.0.0.1',
  pw: env.REDIS_PW || ""
};
var redis = require('redis');
var redisClient = redis.createClient(redisOptions.port, redisOptions.host);
Promise.promisifyAll(redisClient);
redisClient.auth(redisOptions.pw);

router.post('/', function(req, res) {

  var requester = req.body.user_name;
  var channel = req.body.channel_id;
  var commandText = req.body.text;
  var commandSegments = commandText.split(' ');
  var mainCommand = commandSegments[0];
  var cmdOpt = commandSegments.slice(1);

  switch(mainCommand.toLowerCase()) {
    case 'new':
      generatePoll( parseOptions(cmdOpt), channel, res);
      break;
    case 'vote':
      submitVote(cmdOpt, requester ,res);
      break;
    case 'show':
      showPoll(cmdOpt, channel, res);
      break;
    default:
      res.send("Invalid command, valid commands are: \nNEW  [ pollTopic,choice1,choice2,...]\nSHOW [ pollId ]\nVOTE [ pollId choiceNumber ]" );
  }
});

function generatePoll(opts, channel, res){
  var question = opts[0];
  var choices = opts.slice(1);

  redisClient.existsAsync('pollCounter')
  .then(function(resp){
    if(resp === 1){
      return redisClient.incrAsync('pollCounter')
      .then(function(){
        return redisClient.getAsync('pollCounter');
      });
    } else {
      return redisClient.setAsync('pollCounter',0)
      .then(function(){
        return redisClient.getAsync('pollCounter');
      });
    }
  })
  .tap(function(id){
    redisClient.setAsync(id,JSON.stringify({
      id: id,
      question: question,
      choices: choices,
      votes: {}
    }));
  })
  .then(function(id){
    redisClient.getAsync(id)
    .then(formatPoll)
    .then(function(poll){
      postToSlack(poll, channel);
    })
    .then(function(){
      res.send('Poll generated');
    })
    .catch(function(err){
      console.log(err);
    });
  })
  .catch(function(err){
    console.log(err);
  });
}

function submitVote(opts, requester, res){
  var pollId = opts[0];
  var choice = opts[1];

  redisClient.existsAsync(pollId)
  .then(function(exist){
    if(exist === 1){
      return redisClient.getAsync(pollId)
      .then(function(poll){
        var pollJSON = JSON.parse(poll);
        pollJSON.votes[requester] = choice;
        return pollJSON;
      })
      .then( function(poll){
        return redisClient.setAsync(pollId, JSON.stringify(poll) );
      })
      .then(function(success){
        if(success === "OK" ){
          res.send('Successfully voted');
        } else {
          res.send('there was an error');
        }
      });
    } else {
      res.send("Invalid poll id");
    }
  });
}

function showPoll(opts, channel, res){
  var pollId = opts[0];

  redisClient.existsAsync(pollId)
  .then(function(exist){
    if(exist === 1){
      return redisClient.getAsync(pollId)
      .then(function(poll){
        var pollStr = formatPoll(poll);
        postToSlack(pollStr, channel);
        res.send("Poll found");
      });
    } else {
      res.send("Invalid poll id");
    }
  });
}

function getVotesFor(index, votes){
  var count = 0;
  for(var key in votes){
    if(votes[key].toString() == index){
      count++;
    }
  }
  return count;
}

function postToSlack(poll, channel){
  var fields = [];
  poll.choices.forEach(function(choice, idx){
    fields.push({
      title: (idx+1) + ": " + choice,
      value: "Total Votes: " + getVotesFor((idx+1), poll.votes),
      short: false
    });
  });

  request({
    method: 'POST',
    url: 'https://slack.com/api/chat.postMessage',
    qs: {
      token: slackAPIKey,
      channel: channel,
      username: "Poll Bot",
      icon_emoji: ':chart_with_upwards_trend:',
      attachments: JSON.stringify([{
        mrkdwn_in: ['text', 'pretext', 'fields'],
        "fallback": "Required plain-text summary of the attachment.",
        "color": "#019edb",
        "title": "Poll #"+poll.id+" - " + poll.question,
        "text": "Here are the votes",
        "fields": fields
      },{
        mrkdwn_in: ['text', 'pretext', 'fields'],
        "fallback": "Instructions",
        "color": "#000",
        "title": "Poll Bot Instructions",
        fields: [
          {
            title: "Vote in this poll: /poll vote " + poll.id + " {choice number}",
            value: "*Example:* /poll vote " + poll.id + " 2"
          },
          {
            title: "Create a new poll: /poll new {comma separated list}",
            value: "*Example:* /poll new What day is it?, Monday, Tuesday, Wednesday"
          },
          {
            title: "Show a poll: /poll show {poll number}",
            value: "*Example:* /poll show " + poll.id
          }
        ]
      }])
    }
  });
}

function parseOptions(opts){
  // Expects comma separated list of strings
  // First one is the question
  // The rest area the poll choices
  return opts.join(' ').split(',');
}

function formatPoll(pollObj){
  pollObj = JSON.parse(pollObj);
  var question = pollObj.question;
  var choices = pollObj.choices;
  var votes = pollObj.votes;
  var tally = {};
  var answers = [];

  choices.forEach(function(el, idx){
    tally[idx+1] = 0;
  });

  for(var key in votes){
    var selection = votes[key];
    if( tally[selection] !== undefined ){
      tally[selection] += 1;
    }
  }

  return {
    id: pollObj.id,
    question: question,
    choices: choices,
    votes: votes,
    tally: tally
  };
}

module.exports = router;
