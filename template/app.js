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
})();
