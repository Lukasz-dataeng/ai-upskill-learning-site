(function(){
  var qs=document.querySelectorAll.bind(document), byId=document.getElementById.bind(document);

  // build cards: id + difficulty come from data attributes
  var cards=[].slice.call(qs('.q'));
  cards.forEach(function(c){
    c.querySelector('.qh').addEventListener('click',function(e){
      if(e.target.tagName==='INPUT'||e.target.tagName==='LABEL'||e.target.tagName==='BUTTON')return;
      c.classList.toggle('open');
    });
    var cb=c.querySelector('input[type=checkbox]');
    if(cb)cb.addEventListener('change',function(){c.classList.toggle('done',cb.checked);prog();});

    // Searchable text is the question and the answer only. Quiz options are
    // deliberately excluded: searching should not surface a distractor.
    var title=c.querySelector('.qt'), body=c.querySelector('.qb');
    c._txt=((c.querySelector('.qid')||{}).textContent+' '+(title?title.textContent:'')+' '+(body?body.textContent:'')).toLowerCase();

    quiz(c);
  });

  // quiz: opens without revealing the answer, one pick, then every option
  // explains itself. Nothing is scored and nothing is stored.
  function quiz(c){
    var panel=c.querySelector('.quiz'), open=c.querySelector('.quizbtn');
    if(!panel||!open)return;
    open.addEventListener('click',function(){
      var on=c.classList.toggle('quizon');
      open.setAttribute('aria-expanded',on?'true':'false');
      open.textContent=on?'Hide quiz':'Quiz me';
    });
    [].slice.call(panel.querySelectorAll('.quizopt')).forEach(function(b){
      b.addEventListener('click',function(){
        if(panel.classList.contains('answered'))return;
        panel.classList.add('answered');
        b.classList.add('picked');
        panel.classList.add(b.dataset.correct?'right':'wrong');
      });
    });
  }

  function prog(){
    var d=document.querySelectorAll('.q.done').length;
    byId('pdone').textContent=d;
    byId('bar').style.width=(d/cards.length*100)+'%';
  }

  // search
  var filter='all', term='';
  function apply(){
    var shown=0;
    cards.forEach(function(c){
      var okF = filter==='all' || c.dataset.d===filter;
      var okT = !term || c._txt.indexOf(term)>-1;
      var ok = okF&&okT;
      c.classList.toggle('hide',!ok);
      if(ok)shown++;
      if(term&&ok)c.classList.add('open');
    });
    [].slice.call(qs('.sec')).forEach(function(s){
      s.classList.toggle('hide', s.querySelectorAll('.q:not(.hide)').length===0);
    });
    [].slice.call(qs('.tier')).forEach(function(t){
      t.classList.toggle('hide', t.querySelectorAll('.q:not(.hide)').length===0);
    });
    byId('empty').classList.toggle('hide',shown>0);
  }
  byId('q').addEventListener('input',function(e){term=e.target.value.toLowerCase().trim();apply();});
  [].slice.call(qs('.btn[data-f]')).forEach(function(b){
    b.addEventListener('click',function(){
      [].slice.call(qs('.btn[data-f]')).forEach(function(x){x.classList.remove('on');});
      b.classList.add('on'); filter=b.dataset.f; apply();
    });
  });
  byId('fall').classList.add('on');

  // expand all
  var ex=false;
  byId('expand').addEventListener('click',function(){
    ex=!ex; cards.forEach(function(c){c.classList.toggle('open',ex);});
    byId('expand').textContent=ex?'Collapse all':'Expand all';
  });

  // theme
  byId('theme').addEventListener('click',function(){
    var h=document.documentElement;
    h.dataset.theme = h.dataset.theme==='light' ? 'dark' : 'light';
  });

  // scrollspy
  var links=[].slice.call(qs('#nav a'));
  var secs=[].slice.call(qs('.sec'));
  function spy(){
    var y=window.scrollY+140, cur=secs[0];
    secs.forEach(function(s){ if(s.offsetTop<=y) cur=s; });
    links.forEach(function(l){ l.classList.toggle('on', l.dataset.s===cur.id); });
  }
  window.addEventListener('scroll',spy,{passive:true}); spy(); prog();

  interview();

  // mock interview (Slice B). Only the local server (npm run interview)
  // answers GET /api/interview; on the public site the probe fails and none
  // of this appears. The transcript lives in this closure and nowhere else.
  function interview(){
    var btn=byId('ivbtn'), panel=byId('iv');
    if(!btn||!panel||!window.fetch)return;
    var deckId=document.querySelector('.main').dataset.deck;
    var log=byId('ivlog'), start=byId('ivstart'), sel=byId('ivsec'), input=byId('ivinput'), ans=byId('ivans'),
        send=byId('ivsend'), fin=byId('ivfinish'), go=byId('ivgo'), status=byId('ivstatus'), result=byId('ivresult'),
        meta=byId('ivmeta'), count=byId('ivcount');
    var transcript=[], sectionId=null, busy=false, mode='';

    fetch('/api/interview').then(function(r){return r.ok?r.json():null;}).then(function(j){
      if(!j||!j.ok)return;
      mode=j.mode;
      btn.classList.remove('hide');
    }).catch(function(){});

    [].slice.call(qs('.sec')).forEach(function(s){
      var o=document.createElement('option');
      o.value=s.id; o.textContent=s.querySelector('h2').textContent+' ('+s.querySelectorAll('.q').length+' questions)';
      sel.appendChild(o);
    });

    function el(tag,cls,text){var e=document.createElement(tag);if(cls)e.className=cls;if(text!=null)e.textContent=text;return e;}
    function show(e,on){e.classList.toggle('hide',!on);}
    function setBusy(on,text){
      busy=on; [send,fin,go].forEach(function(b){b.disabled=on;});
      status.classList.remove('err'); status.textContent=text||''; show(status,!!text);
    }
    function error(text){status.classList.add('err');status.textContent=text;show(status,true);}
    function setMeta(extra){meta.textContent=(mode==='stub'?'stub mode, canned replies · ':'')+(extra||'');}

    btn.addEventListener('click',function(){
      var on=panel.classList.contains('hide');
      show(panel,on); btn.setAttribute('aria-expanded',on?'true':'false'); setMeta();
      if(on)panel.scrollIntoView({block:'nearest'});
    });
    byId('ivclose').addEventListener('click',function(){show(panel,false);btn.setAttribute('aria-expanded','false');});

    function addTurn(turn){
      var t=el('div','ivturn '+turn.role);
      t.appendChild(el('small',null,turn.role==='interviewer'?'Interviewer · '+turn.questionId:'You'));
      t.appendChild(document.createTextNode(turn.text));
      log.appendChild(t); log.scrollTop=log.scrollHeight;
    }

    // Nothing is added to the transcript, and the text box is not cleared,
    // until the server has answered. A failed call loses nothing.
    function call(action,pending){
      if(busy)return;
      var body={deckId:deckId,sectionId:sectionId,action:action,transcript:transcript.concat(pending||[])};
      setBusy(true,action==='finish'?'Grading your answers…':'Waiting for the interviewer…');
      fetch('/api/interview',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})
        .then(function(r){
          return r.json().catch(function(){return {};}).then(function(j){return {status:r.status,ok:r.ok,j:j};});
        },function(){ return {network:true}; })
        .then(function(res){
          setBusy(false);
          if(res.network)return error('The local interview server is not running. Start npm run interview and send again.');
          if(res.status===502)return error('DIAL did not answer. Check the EPAM VPN is connected and send again.');
          if(!res.ok)return error(res.j.error||('The server returned HTTP '+res.status+'.'));
          (pending||[]).forEach(function(t){transcript.push(t);addTurn(t);});
          ans.value=''; counter();
          if(res.j.scores)return results(res.j);
          var turn={role:'interviewer',text:res.j.text,questionId:res.j.questionId};
          transcript.push(turn); addTurn(turn);
          setMeta(res.j.turnsLeft>0?res.j.turnsLeft+' more question'+(res.j.turnsLeft===1?'':'s')+' at most':'last question');
          ans.focus();
        });
    }

    go.addEventListener('click',function(){
      transcript=[]; sectionId=sel.value; log.innerHTML=''; result.innerHTML='';
      show(result,false); show(start,false); show(input,true);
      call('next');
    });
    function answer(){return ans.value.trim()?[{role:'candidate',text:ans.value.trim()}]:[];}
    send.addEventListener('click',function(){ if(ans.value.trim())call('next',answer()); else ans.focus(); });
    fin.addEventListener('click',function(){ call('finish',answer()); });
    ans.addEventListener('keydown',function(e){ if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)){e.preventDefault();send.click();} });
    function counter(){count.textContent=ans.value.length+' / 4000';}
    ans.addEventListener('input',counter);

    function cardTitle(id){var c=byId('q-'+id);return c?c.querySelector('.qt').textContent:'Question '+id;}
    function results(j){
      show(input,false); show(start,true); go.textContent='Start another'; setMeta();
      result.innerHTML=''; show(result,true);
      if(j.forced)result.appendChild(el('p','ivstatus','You reached the '+12+'-turn limit, so the interview was graded as it stood.'));

      result.appendChild(el('h3',null,'Scores'));
      j.scores.forEach(function(s){
        var box=el('div','ivscore'), top=el('div','top');
        top.appendChild(el('span','n '+(s.score<=2?'lo':s.score<=3?'mid':'hi'),s.score+'/5'));
        top.appendChild(el('span','t',s.questionId+' · '+cardTitle(s.questionId)));
        box.appendChild(top);
        if(s.missed.length||s.wrong.length){
          var ul=el('ul');
          s.wrong.forEach(function(w){ul.appendChild(el('li','w','Wrong: '+w));});
          s.missed.forEach(function(m){ul.appendChild(el('li',null,'Missed: '+m));});
          box.appendChild(ul);
        }
        result.appendChild(box);
      });

      result.appendChild(el('h3',null,'Study next'));
      var ol=el('ol','ivplan');
      j.plan.forEach(function(p){
        var li=el('li'), a=el('a',null,p.questionId+' · '+cardTitle(p.questionId));
        a.href='#q-'+p.questionId;
        a.addEventListener('click',function(e){
          var c=byId('q-'+p.questionId); if(!c)return;
          e.preventDefault(); c.classList.add('open'); c.scrollIntoView({behavior:'smooth',block:'start'});
        });
        li.appendChild(a); li.appendChild(document.createTextNode(' — '+p.why));
        ol.appendChild(li);
      });
      result.appendChild(ol);
    }
  }
})();
