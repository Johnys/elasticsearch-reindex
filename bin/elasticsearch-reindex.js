#!/usr/bin/env node

var cli           = require('commander'),
    elasticsearch = require('elasticsearch'),
    AgentKeepAlive = require('agentkeepalive'),
    cluster       = require('cluster'),
    moment        = require('moment'),
    _             = require('underscore'),
    bunyan        = require('bunyan'),
    Multiprogress = require("multi-progress"),
    fs            = require('fs'),
    Indexer       = require('../lib/indexer'),
    async     = require('async');

const file = fs.createWriteStream('./reindex-out.log');

var multi = new Multiprogress(console.stdout);

var CPU_COUNT = require('os').cpus().length;

function make_scan_opts(from, cli) {
  
  if (cli.from_ver === '1.7' || cli.from_ver === '0.90') {
    return {
      index       : from.index,
      type        : from.type,
      search_type : 'scan',
      scroll      : cli.scroll,
      size        : cli.query_size,
      body        : {}
    };
  }

  return {
    index       : from.index,
    type        : from.type,
    scroll      : cli.scroll,
    size        : cli.query_size,
    body        : {
      sort: "_doc"
    }
  };
}

cli
.version('1.1.11')
.option('-f, --from [value]', 'source index, eg. http://192.168.1.100:9200/old_index/old_type')
.option('-t, --to [value]', 'to index, eg. http://192.168.1.100:9200/new_index/new_type')
.option('-c, --concurrency [value]', 'concurrency for reindex', CPU_COUNT)
.option('-b, --bulk [value]', 'bulk size for a thread', 100)
.option('-q, --query_size [value]', 'query size for scroll', 100)
.option('-s, --scroll [value]', 'default 1m', '1m')
.option('-i, --sniff_cluster [value]', 'sniff the rest of the cluster upon initial connection and connection errors', true)
.option('-o, --request_timeout [value]', 'default 60000', 60000)
.option('-l, --log_path [value]', 'default ./reindex.log', './reindex.log')
.option('-n, --max_docs [value]', 'default -1 unlimited', -1)
.option('--from_ver [value]', 'default 1.7', '1.7')
.option('--to_ver [value]', 'default 1.7', '1.7')
.option('-p, --parent [value]', 'if set, uses this field as parent field', '')
.option('-m, --promise [value]', 'if set indexes expecting promises, default: false', false)
.option('-z, --compress [value]', 'if set, requests compression of data in transit', false)
.option('-a, --access_key [value]', 'AWS access key', false)
.option('-k, --secret_key [value]', 'AWS secret ket', false)
.option('-e, --region [value]', 'AWS region', false)
.option('--a, --async_forks [value]', 'Amount of async forks to process', CPU_COUNT)
.parse(process.argv);

for (var key in cli) {
  if (cli.hasOwnProperty(key)) {
    if (cli[key] === 'false') {
      cli[key] = false;
    } else if (cli[key] === 'true') {
      cli[key] = true;
    }
  }
}

var logger = bunyan.createLogger({
  src: true,
  name: "elasticsearch-reindex",
  streams: [{
    path: cli.log_path
  }]
});

var custom_indexer = cli.args[0] ? require(fs.realpathSync(cli.args[0])) : null;

if (cluster.isMaster) {
  var workers = [];
  if (custom_indexer && custom_indexer.sharded) {
    var ranges = [];
    if (custom_indexer.sharded.ranges) {
      ranges = custom_indexer.sharded.ranges;
    } else {
      var now = moment();
      if (!custom_indexer.sharded.start) {
        throw new Error("Start time has to be defined in sharded indexer.")
      }
      var start = moment(custom_indexer.sharded.start);
      var end = custom_indexer.sharded.end ? moment(custom_indexer.sharded.end) : now;
      if (!start) {
        throw new Error("Start of the range has to be specified for sharded indexer.");
      }
      var current = start;
      var interval_days = 1;
      if (custom_indexer.sharded.interval) {
        switch(custom_indexer.sharded.interval) {
          case 'month':
            interval_days = 30;
            break;
          case 'week':
            interval_days = 7;
            break;
          default: {
            var days = parseInt(custom_indexer.sharded.interval);
            if (days) interval_days = days;
          }
        }
      } else {
        interval_days = Math.ceil(end.diff(start, 'days') / cli.concurrency);
      }
      do {
        var current_end = current.clone().add(interval_days, 'days');
        if (current_end > end) {
          current_end = end;
        }
        ranges.push({
          name: current.format('YYMMDD') + '-' + current_end.format('YYMMDD'),
          range: {
            gte: current.format('YYYY-MM-DD'),
            lt: current_end.format('YYYY-MM-DD')
          }
        });
        current = current_end;
      } while (current < end);
    }
    ranges.forEach(function(shard) {
      var worker_arg = {range:{}, name: shard.name};
      worker_arg.range[custom_indexer.sharded.field] = shard.range;
      workers.push(worker_arg);
    });
  } else {
    workers.push({name: "single"})
  }

  console.log("Starting reindex in " + workers.length + " shards.")
  if (workers.length > 1 & cli.max_docs > -1) console.log("Warning: every worker in his range will only index limited documents when max_docs used");
  var docs = {};
  var executionWorkers = {};
  async.eachLimit(workers, cli.async_forks, function(args, done) {
    let worker = cluster.fork({worker_arg:JSON.stringify(args)});
    let current = Object.keys(executionWorkers).length + 1;
    executionWorkers[worker.process.pid] = { done };
    worker.on('message', function(msg) {
      if(!executionWorkers[worker.process.pid].bar) {
        executionWorkers[worker.process.pid].bar = multi.newBar(`reindexing [:bar] :current/:total(:percent) :elapsed :etas ${current}/${workers.length} ${args.name}`, {total:0, width:30});
      }
      let bar = executionWorkers[worker.process.pid].bar;
      if (msg.total) {
        var cnt = Object.keys(docs).length;
        docs[msg.pid] = msg.total;
        if (cnt < Object.keys(docs).length) {
          bar.total = bar.total + msg.total;
        }
      }
      else  bar.tick(msg.success, {shards: Object.keys(docs).length});
    });
  });

  cluster.on('exit', function(worker, code, signal) {
    if( signal ) {
      logger.fatal("worker was killed by signal: "+signal);
      console.log("worker was killed by signal: "+signal);
    }
    let bar = executionWorkers[worker.process.pid].bar;
    delete docs[worker.process.pid];
    executionWorkers[worker.process.pid].done();
    if (Object.keys(cluster.workers).length === 0) {
      if (bar.total === bar.curr)
        console.log('Reindexing completed sucessfully.');
      else
        console.log('Failed to reindex ' + (bar.total - bar.curr) + ' (~'+ Math.round((100-(bar.curr/bar.total)*100)*1000)/1000 +'%) documents.');
    }
  });
} else {
  var worker_arg = null;
  var range = null;
  var shard_name = '';

  if (process.env.worker_arg) {
    worker_arg = JSON.parse(process.env.worker_arg);
    range = worker_arg.range;
    shard_name = cluster.worker.id;
  }

  function createClient(uri, apiVersion) {
    if (!/\w+:\/\//.test(uri)) {
      uri = 'http://' + uri;
    }

    var uri = uri.lastIndexOf('/') === uri.length -1 ? uri.substr(0, uri.length -1) : uri;
    var tokens = uri.split('/');
    var res = {};
    if (tokens.length >= 4) {
      res.type = tokens.pop();
      res.index = tokens.pop();
    }
    var config = {
      requestTimeout: cli.request_timeout,
      apiVersion: apiVersion,
      suggestCompression: cli.compress,
      sniffOnStart: cli.sniff_cluster,
      sniffOnConnectionFault: cli.sniff_cluster
    };

    if (cli.access_key && cli.secret_key && cli.region && /\.amazonaws\./.test(uri)) {
      config.connectionClass = require('http-aws-es');
      config.amazonES = {
        accessKey: cli.access_key,
        secretKey: cli.secret_key,
        region: cli.region
      };
    }

    config.host = res.host = tokens.join('/');

    if (tokens[2].indexOf("@") !== -1) {
        var data = tokens[2].split("@");
        tokens[1] = data[0];
        tokens[2] = data[1];
    }


    if (tokens[2].indexOf(":") !== -1) {
        var hostData = tokens[2].split(":");
        tokens[2] = hostData[0];
        tokens[3] = hostData[1];
    }
    res.client = new elasticsearch.Client({
        hosts: [{
        host: tokens[2],
        protocol: tokens[0].replace(":", ""),
        auth: tokens[1] != "" ? tokens[1] : null,
        port: tokens[3] != "" ? tokens[3] : "9200",
        }],
        maxRetries: 10,
        keepAlive: true,
        maxSockets: 10,
        minSockets: 10,
        requestTimeout: cli.request_timeout, 
        createNodeAgent: function (connection, config) {
            if("https" === config.hosts[0].protocol) {
            return new AgentKeepAlive.HttpsAgent(connection.makeAgentConfig(config));
            }
            return new AgentKeepAlive(connection.makeAgentConfig(config));
        }
      }
    );
    return res;
  }

  if (!cli.from || !cli.to) {
    throw new Error('"from" and "to" parameters are required');
  }

  var from = createClient(cli.from, cli.from_ver);
      to = createClient(cli.to, cli.to_ver),
      processed_total = 0,
      processed_failed = 0;

  var scan_options = make_scan_opts(from, cli);

  if (range) {
    _.defaults(scan_options.body, {query:{range:range}});
  }

  if (custom_indexer && custom_indexer.query) {
    scan_options.body = _.extend(scan_options.body, custom_indexer.query);
  }

  var reindexer = new Indexer();

  reindexer.on('item-failed', function(item) {
    processed_failed++;
    logger.warn(item);
  });

  reindexer.on('error', function(error) {
    logger.error(error);
  });

  reindexer.on('batch-complete', function(num_of_success) {
    process.send({success: num_of_success});
  });

  from.client.search(scan_options, function scroll_fetch(err, res) {
    if (err) {
      if (err.message instanceof Error) {
        err = err.message;
      }
      logger.fatal(JSON.stringify({ err, worker_arg }));
      if (err.message.indexOf('parse') > -1) {
        console.log(err);
        throw new Error("Scroll body parsing error, query_size param is possibly too high.");
      } else {
        throw new Error("Scroll error: " + err);
      }
    }
    if (!res.hits.total) {
      logger.info('No documents can be found!');
      return process.exit();
    }
    var total = cli.max_docs === -1 ? res.hits.total : (cli.max_docs > res.hits.total ? res.hits.total : cli.max_docs);
    total = parseInt(total);
    process.send({total: total, pid: process.pid});
    var docs = res.hits.hits,
      reindexMethod = cli.promise ? 'indexPromise' : 'index';

    processed_total = processed_total + docs.length;
    if (processed_total > total) {
      docs = docs.slice(0, total - processed_total);
      processed_total = total;
    }
    reindexer[reindexMethod](docs, {
      concurrency : cli.concurrency,
      bulk        : cli.bulk,
      client      : to.client,
      indexer     : custom_indexer ? custom_indexer.index : null,
      index       : to.index,
      type        : to.type,
      parent      : cli.parent
    }, function(err) {
      if (err) {
        logger.fatal(JSON.stringify({ err, worker_arg }));
        console.log("\nReindex error: " + err);
      }
      if (processed_total < total) {
        from.client.scroll({
          scroll_id : res._scroll_id,
          scroll : cli.scroll
        }, scroll_fetch);
      } else {
        var msg = "    " + shard_name + " Total " + processed_total + " documents have been processed!";
        if (processed_failed) {
          msg +=   " about " + processed_failed + " documents reindex failed, see the " + cli.log_path;
        }
        logger.info(msg);
        process.exit();
      }
    });
  });
}
