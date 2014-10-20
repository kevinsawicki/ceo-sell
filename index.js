var async     = require('async');
var cheerio   = require('cheerio');
var colors    = require('colors');
var ceos      = require('./ceos.json');
var Humanize  = require('humanize-plus');
var request   = require('request');
var Progress  = require('progress');
var timeago   = require('timeago');
var url       = require('url');
var XmlStream = require('xml-stream');

var oneWeekAgo = Date.now() - (7 * 24 * 60 * 60 * 1000)

// Wrap a callback to ensure it is only called once.
var wrapCallback = function(callback) {
  var callbackCalled = false;
  return function() {
    if (!callbackCalled)
      callback.apply(null, arguments);
    callbackCalled = true;
  };
}

// Get the last 50 Form Four filings for the given id
var getLatestFilings = function(id, callback) {
  callback = wrapCallback(callback);

  var requestOptions = {
    uri: 'http://www.sec.gov/cgi-bin/browse-edgar',
    qs: {
      action: 'getcompany',
      CIK: id,
      count: 50,
      output: 'atom',
      owner: 'include',
      type: 4
    }
  };
  var filingRequest = request(requestOptions);
  filingRequest.on('error', function(error) {
    callback(new Error("Failed to get latest filing for: " + id + ". " + error.message));
  });

  var filings = [];
  var filingUrl;
  var filingDate;

  var parser = new XmlStream(filingRequest, 'utf8');

  parser.on('startElement: entry', function() {
    filingUrl = '';
    filingDate = '';
  });

  parser.on('text: entry > content > filing-href', function (node) {
    filingUrl += node.$text;
  });

  parser.on('text: entry > updated', function (node) {
    filingDate += node.$text;
  });

  parser.on('endElement: entry', function() {
    filingUrl = filingUrl.trim();
    filingDate = Date.parse(filingDate.trim());
    if (filingUrl && isFinite(filingDate) && filingDate > oneWeekAgo)
      filings.push({date: filingDate, rootUrl: filingUrl, id: id});
  });

  parser.on('end', function() {
    callback(null, filings);
  });

  parser.on('error', callback);
};

// Get the XML file URL of the given filing
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

// Get the HTML file URL of the given filing
var getFilingHtmlFileUrl = function(filingHref, callback) {
  request(filingHref, function(error, response, body) {
    if (error) return callback(error);

    var htmlName = cheerio(body).find('a[href^="/Archives"]').first().attr('href');
    if (!htmlName) return callback(new Error("No link to HTML file found: " + filingHref));

    var htmlUrl = url.resolve('http://www.sec.gov/', htmlName);
    callback(null, htmlUrl);
  });
}

// Get the number of shares sold and the amount they were sold for in USD
// for the given filing.
var getSharesAndPrice = function(companySymbol, xmlFileUrl, callback) {
  callback = wrapCallback(callback);
  var parser = new XmlStream(request(xmlFileUrl), 'utf8');

  var totalShares = 0;
  var amountInDollars = 0;

  var shares;
  var price;
  var type;
  var symbol = '';

  parser.on('startElement: transactionAmounts', function(name) {
    price =  '';
    shares = '';
    type = '';
  });

  parser.on('text: transactionAmounts > transactionShares > value', function(node) {
    shares += node.$text;
  });

  parser.on('text: transactionAmounts > transactionPricePerShare > value', function(node) {
    price += node.$text;
  });

  parser.on('text: transactionAmounts > transactionAcquiredDisposedCode > value', function(node) {
    type += node.$text;
  });

  parser.on('text: issuer > issuerTradingSymbol', function(node) {
    symbol += node.$text;
  });

  parser.on('endElement: issuerTradingSymbol', function(node) {
    if (companySymbol !== symbol.trim()) callback();
  });

  parser.on('endElement: transactionAmounts', function(name) {
    shares = parseFloat(shares);
    price = parseFloat(price)
    type = type.trim();
    if (type === 'D') {
      if (price > 0 && isFinite(price)) {
        if (shares > 0 && isFinite(shares)) {
          totalShares += shares;
          amountInDollars += price * shares;
        }
      }
    }
  });

  parser.on('end', function () {
    callback(null, totalShares, amountInDollars);
  });

  parser.on('error', callback);
};

// Load the XML URL, HTML URL, share, and dollar information for the filing
var getFilling = function(filing, callback) {
  var tasks = [];

  tasks.push(function(callback) {
    getFilingXmlFileUrl(filing.rootUrl, function(error, xmlFileUrl) {
      filing.xmlUrl = xmlFileUrl;
      callback(error);
    });
  });

  tasks.push(function(callback) {
    getFilingHtmlFileUrl(filing.rootUrl, function(error, htmlFileUrl) {
      filing.htmlUrl = htmlFileUrl;
      callback(error);
    });
  });

  tasks.push(function(callback) {
    getSharesAndPrice(ceos[filing.id].symbol, filing.xmlUrl, function (error, shares, dollars) {
      filing.shares = shares;
      filing.dollars = dollars;
      callback(error);
    });
  });

  async.waterfall(tasks, callback);
};

// Get the recent sales of stock
var getRecentSales = function(id, filingCallback) {
  filingCallback = wrapCallback(filingCallback);
  var sales = [];

  getLatestFilings(id, function(error, filings) {
    if (error) return filingCallback(error);

    var queue = async.queue(function(filing, queueCallback) {
      getFilling(filing, function(error) {
        if (error) {
          filingCallback(error);
          queue.kill();
        }

        if (filing.shares > 0 && filing.dollars > 0)
          sales.push(filing);
        queueCallback();
      });
    });
    queue.push.call(queue, filings);
    queue.drain = function() {
      filingCallback(null, sales);
    };
    queue.concurrency = 10;
  });
};

// Generate a messages from the given filing
var generateMessage = function(filing) {
  var ceo = ceos[filing.id];
  return ceo.company + " CEO " + ceo.name + " sold " + Humanize.compactInteger(filing.shares, 0).green
    + " $" + ceo.symbol + " shares for " + ("$" + Humanize.compactInteger(filing.dollars, 1)).green
    + " " + timeago(new Date(filing.date))
    + " " + filing.htmlUrl;
}

var progressOptions = {
  clear: true,
  total: Object.keys(ceos).length,
  width: 40
};
var progress = new Progress('downloading transactions [:bar] :percent :etas', progressOptions);

var allSales = [];

var queue = async.queue(function(id, callback) {
  getRecentSales(id, function(error, sales) {
    progress.tick();
    if (error)
      console.error(error.message || error);
    else
      allSales = allSales.concat(sales);
    callback();
  });
});
queue.concurrency = 10;
queue.push.call(queue, Object.keys(ceos));
queue.drain = function() {
  console.log("CEOs that sold stock in the last week".underline.yellow);
  allSales.sort(function(filing1, filing2) {
    return filing1.date - filing2.date;
  });
  allSales.forEach(function(filing) {
    console.log(generateMessage(filing));
  });
};
