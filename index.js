var async     = require('async');
var cheerio   = require('cheerio');
var ceos      = require('./ceos.json');
var Humanize  = require('humanize-plus');
var request   = require('request');
var url       = require('url');
var XmlStream = require('xml-stream');

var wrapCallback = function(callback) {
  var callbackCalled = false;
  return function() {
    if (!callbackCalled)
      callback.apply(null, arguments);
    callbackCalled = true;
  };
}

var getLatestFiling = function(id, callback) {
  callback = wrapCallback(callback);

  var requestOptions = {
    uri: 'http://www.sec.gov/cgi-bin/browse-edgar',
    qs: {
      action: 'getcompany',
      CIK: id,
      count: 1,
      output: 'atom',
      owner: 'include',
      type: 4
    }
  };
  var filingRequest = request(requestOptions);
  filingRequest.on('error', function(error) {
    callback(new Error("Failed to get latest filing for: " + id + ". " + error.message));
  });

  var filingUrl = '';
  var filingDate = '';

  var parser = new XmlStream(filingRequest, 'utf8');
  parser.on('text: entry > content > filing-href', function (node) {
    filingUrl += node.$text;
  });

  parser.on('text: entry > updated', function (node) {
    filingDate += node.$text;
  });

  parser.once('endElement: entry', function() {
    filingUrl = filingUrl.trim()
    filingDate = Date.parse(filingDate.trim());
    callback(null, filingUrl, filingDate)
  });

  parser.on('end', function() {
    callback(new Error("No filing URL and date found in feed: " + id))
  });
};

var getFilingXmlFileUrl = function(filingHref, callback) {
  callback = wrapCallback(callback);

  var folderUrl = url.resolve(filingHref, '.');
  request(folderUrl, function(error, response, body) {
    if (error) return callback(new Error("Request failed: " + folderUrl + " " + error.message));

    var fileName = cheerio(body).find('a[href$=".xml"]').first().text();
    if (!fileName) return callback(new Error("No link to XML file found: " + folderUrl));

    var fileUrl = url.resolve(folderUrl, fileName);
    callback(null, fileUrl);
  });
};

var getFilingHtmlFileUrl = function(filingHref, callback) {
  request(filingHref, function(error, response, body) {
    if (error) return callback(error);

    var htmlName = cheerio(body).find('a[href^="/Archives"]').first().attr('href');
    if (!htmlName) return callback(new Error("No link to HTML file found: " + filingHref));

    var htmlUrl = url.resolve('http://www.sec.gov/', htmlName);
    callback(null, htmlUrl);
  });
}

var parseFilingXml = function(xmlFileUrl, callback) {
  callback = wrapCallback(callback);
  var parser = new XmlStream(request(xmlFileUrl), 'utf8');

  var totalShares = 0;
  var amountInDollars = 0;

  var currentShares;
  var currentPrice;
  var currentType;

  parser.on('startElement: transactionAmounts', function(name) {
    currentPrice = 0;
    currentShares = 0;
    currentType = null;
  });

  parser.on('text: transactionAmounts > transactionShares > value', function(node) {
    currentShares = parseFloat(node.$text);
  });

  parser.on('text: transactionAmounts > transactionPricePerShare > value', function(node) {
    currentPrice = parseFloat(node.$text);
  });

  parser.on('text: transactionAmounts > transactionAcquiredDisposedCode > value', function(node) {
    currentType = node.$text.trim();
  });

  parser.on('endElement: transactionAmounts', function(name) {
    if (currentType === 'D') {
      if (currentPrice > 0 && isFinite(currentPrice)) {
        if (currentShares > 0 && isFinite(currentShares)) {
          totalShares += currentShares;
          amountInDollars += currentPrice * currentShares;
        }
      }
    }
  });

  parser.on('end', function () {
    callback(null, totalShares, amountInDollars);
  });

  parser.on('error', callback);
};

var getLatestTransaction = function(id, callback) {
  var tasks = [];
  var results = {};

  tasks.push(function(callback) {
    getLatestFiling(id, function(error, filingHref, filingDate) {
      results.rootUrl = filingHref;
      results.date = filingDate;
      callback(error);
    });
  })

  tasks.push(function(callback) {
    getFilingXmlFileUrl(results.rootUrl, function(error, xmlFileUrl) {
      results.xmlUrl = xmlFileUrl;
      callback(error);
    });
  });

  tasks.push(function(callback) {
    getFilingHtmlFileUrl(results.rootUrl, function(error, htmlFileUrl) {
      results.htmlUrl = htmlFileUrl;
      callback(error);
    });
  });

  tasks.push(function(callback) {
    parseFilingXml(results.xmlUrl, function (error, shares, dollars) {
      results.shares = shares;
      results.dollars = dollars;
      callback(error);
    });
  });

  async.waterfall(tasks, function(error) {
    callback(error, results);
  });
};

var generateTweet = function(ceo, results) {
  return ceo.name + " sold " + Humanize.compactInteger(results.shares, 0)
    + " shares for $" + Humanize.compactInteger(results.dollars, 1)
    + " on " + new Date(results.date).toString()
    + " " + results.htmlUrl;
}

var queue = async.queue(function(id, callback) {
  getLatestTransaction(id, function(error, results) {
    if (error)
      console.error(error.message || error);
    else if (results && results.shares > 0 && results.dollars > 0)
      console.log(generateTweet(ceos[id], results));
    callback();
  });
});
queue.concurrency = 10;
queue.push.call(queue, Object.keys(ceos));
