var express = require('express');
var http = require('http');
var xml = require('node-xml');
var fs = require('fs');
var lb = express.createServer();
var testServer = express.createServer();
lb.use(express.bodyParser());
testServer.use(express.bodyParser());
var servers = new Array();
var serverPorts = new Array();
var serverData = new Array();

var probabilityMax;

testServer.get('/', function(req,res){
	res.contentType("text/xml");
	res.sendfile('test.xml');
});

lb.get('/', function(req, res){
	//TODO: make this work algorithmically
	var ip = getServer();
	if(ip != null)
	{
		res.send({ip: ip, port: serverPorts[ip]});
	}
	else
	{
		res.send({error: 'Something bad happened.'});
	}
});

function getServer()
{
	var random = Math.random() * probabilityMax;
	var current = 0;
	var i;
	for(i in servers)
	{
		var server = serverData[servers[i]];
		if(current + server.probability >= random)
		{
			return servers[i];
		}
		current += server.probability;
	}
	return null;
}

lb.post('/add', function(req, res){
	//TODO: get the actual IP and parse it
	var ip = req.body.ip;
	var port = req.body.port;
	console.log('add: ' + ip + ':' + port);
	servers.push(ip);
	serverPorts[ip] = port;
	var serverJson = {};
	//write to file
	for(var i in serverPorts)
	{
		
	}
	serverData[ip] = new Object();
	res.send('ok');
});
lb.post('/remove', function(req, res){
	//TODO: get the actual IP and parse it
	var ip = req.body.ip;
	console.log('remove: ' + ip);
	if(servers.indexOf(ip) != -1)
	{
		servers.splice(servers.indexOf(ip), 1);
		serverData[ip] = null;
		serverPorts[ip] = null;
	}
	res.send('ok');
});

//poll all servers every 15 seconds
setInterval(function(){
	
	for(i in servers)
	{
		var server = servers[i];
		var options = {
			host: server,
			port: serverPorts[server],
			path: '/'
		};
		var get = http.request(options, function(response){
			//TODO: get the actual data and parse it
			var data = '';
			response.on('data', function(chunk){
				data += chunk;
			});
			response.on('end', function(){
				var currentElem = '';
				var recorded = false;
				var parser = new xml.SaxParser(function(cb) {
					cb.onStartElementNS(function(elem, attrs, prefix, uri, namespaces) {
						currentElem = elem;
						recorded = false;
					});
					cb.onCharacters(function(chars) {
						
						if(recorded == false){
							serverData[server][currentElem] = chars;
							recorded = true;
						}
					});
				});

				parser.parseString(data);
			});
		});
		get.on('error', function(error) {
			console.log('unable to connect to server: ' + error);
		});
		get.end();
	}
	//pause a little to make sure the parser is done
	setTimeout(function(){
		//don't update probabilityMax until it's done computing
		var tempProbMax = 0;
		//calculate percentages
		for(var i in servers)
		{
			var server = serverData[servers[i]];
			var server = serverData[servers[i]];
			tempProbMax += server.maxconns - server.totalconns;
			server.probability = server.maxconns - server.totalconns;
			server.lastupdate = server.timestamp;
		}
		probabilityMax = tempProbMax;
	},
	200);
	
},
//number of seconds
5000);

lb.listen(3000, '69.10.20.43');
testServer.listen(3001);
