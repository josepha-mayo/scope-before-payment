'use strict';
(function(root,factory){const api=factory();if(typeof module==='object')module.exports=api;else root.ScopeFixtures=api;})(globalThis,()=>{
// Entirely authored synthetic data. No model result or real customer conversation.
const initial=[
{id:'B1',role:'buyer',text:'Could you draw a fox for my café launch? I need an A4 display and an Instagram post by November 20.'},
{id:'M1',role:'merchant',text:'My $60 option is one character, a digital file, one revision, personal use only; printing is not included.'},
{id:'B2',role:'buyer',text:'Could we make that two foxes and put it on 500 takeaway cups? I can pay $60 today.'},
{id:'M2',role:'merchant',text:'Two characters would be $90. Commercial use needs a separate quote. My earliest delivery is November 24.'},
{id:'B3',role:'buyer',text:'Then one fox is fine, but the November 20 launch cannot move.'}];
const resolution=[
{id:'M3',role:'merchant',text:'I can offer one fox as a digital PNG for your A4 sign, 500 takeaway cups and café Instagram promotion. One revision, no physical prints, delivery November 24. All-in $120 for this exact order; I cannot meet November 20.'},
{id:'B4',role:'buyer',text:'I can move to November 24. I will print the sign and cups myself. Those three café uses, one fox, one revision and digital delivery only, for $120.'},
{id:'M4',role:'merchant',text:'Confirmed: one fox, digital PNG for the A4 sign, 500 takeaway cups and café Instagram promotion, one revision, no physical printing, November 24, all-in $120. Payment before work starts.'},
{id:'B5',role:'buyer',text:'I accept that exact $120 scope and November 24 delivery. Please send the payment request.'}];
function draft(session,resolved=false){const ms=session.view().messages,r=(messageId,quote)=>({messageId,quote}),pair=(a,b)=>[r(a,ms.find(m=>m.id===a).text),r(b,ms.find(m=>m.id===b).text)];return {kind:'authored_scope_draft',sourceBinding:session.sourceBinding(),observations:resolved?[
{id:'deliverable',topic:'deliverable',proposedText:'One fox; digital PNG only. Buyer handles physical printing.',needsClarification:false,refs:pair('B4','M4')},
{id:'usage',topic:'usage',proposedText:'A4 café sign, 500 takeaway cups and café Instagram promotion.',needsClarification:false,refs:pair('B4','M4')},
{id:'deadline',topic:'deadline',proposedText:'November 24 replaces the earlier requested November 20.',needsClarification:false,refs:pair('B4','M4')},
{id:'price',topic:'price',proposedText:'The final explicit all-in quote is $120, not either earlier option.',needsClarification:false,refs:pair('B5','M4')},
{id:'revisions',topic:'revisions',proposedText:'One revision; payment before work starts.',needsClarification:false,refs:pair('B4','M4')}
]:[
{id:'deliverable',topic:'deliverable',proposedText:'Latest buyer request returns to one fox; digital versus physical fulfillment needs review.',needsClarification:true,refs:pair('B3','M1')},
{id:'usage',topic:'usage',proposedText:'Café promotion and 500 cups conflict with the old personal-use option.',needsClarification:true,refs:pair('B2','M1')},
{id:'deadline',topic:'deadline',proposedText:'Buyer needs November 20; merchant can deliver November 24.',needsClarification:true,refs:pair('B3','M2')},
{id:'price',topic:'price',proposedText:'Neither $60 nor $90 is a confirmed final price for the latest commercial scope.',needsClarification:true,refs:pair('B2','M2')},
{id:'revisions',topic:'revisions',proposedText:'The old option included one revision; confirm it for the new scope.',needsClarification:true,refs:pair('B2','M1')}
]};}
return {initial,resolution,draft};
});
