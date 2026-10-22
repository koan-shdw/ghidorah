from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
ROOT=Path(__file__).resolve().parents[1]
sys.path[:0]=[str(ROOT/'backend'),str(ROOT/'runtime/hermes')]
from workspace_git_actions import inspect,execute

class GitActionsTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name);self.repo=self.root/'Repository with spaces';self.repo.mkdir()
        self.git('init','-q','-b','main');self.git('config','user.name','Fixture');self.git('config','user.email','fixture@example.invalid');self.git('config','commit.gpgSign','false');self.git('config','core.autocrlf','false');self.git('config','core.hooksPath',str(self.root/'no-hooks'))
    def git(self,*args,cwd=None):
        return subprocess.run(['git','-C',str(cwd or self.repo),*args],check=True,capture_output=True,text=True,encoding='utf-8',creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0)).stdout.strip()
    def write(self,name,text):
        p=self.repo/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_text(text,encoding='utf-8')
    def action(self,action,**kwargs):
        directory=kwargs.pop('directory',self.repo);state=inspect(self.root,directory)
        return execute(dict(root=str(self.root),directory=str(directory),action=action,revision=state['revision'],**kwargs))
    def initial(self):
        self.write('nested/file with spaces.txt','base\n');self.write('other.txt','other\n');self.git('add','.');self.git('commit','-qm','base')
    def test_selected_staging_commit_and_unstage_keep_unrelated_content(self):
        self.initial();self.write('nested/file with spaces.txt','new\n');self.write('other.txt','staged\n');self.git('add','other.txt');self.write('other.txt','unstaged\n')
        self.action('stage',directory=self.repo/'nested',file='file with spaces.txt')
        self.assertEqual(self.git('show',':nested/file with spaces.txt'),'new');self.assertEqual(self.git('show',':other.txt'),'staged')
        self.action('unstage',file='other.txt');self.action('commit',message='Change selected file')
        self.assertEqual(self.git('diff-tree','--no-commit-id','--name-only','-r','HEAD'),'nested/file with spaces.txt');self.assertEqual((self.repo/'other.txt').read_text(),'unstaged\n')
        with self.assertRaisesRegex(ValueError,'Stage the files'):self.action('commit',message='Never stage everything implicitly')
    def test_unborn_unstage_keeps_working_file(self):
        self.write('new.txt','one\n');self.action('stage',file='new.txt');self.write('new.txt','two\n');self.action('unstage',file='new.txt');self.assertEqual((self.repo/'new.txt').read_text(),'two\n');self.assertEqual(self.git('ls-files'),'')
    def test_same_size_edit_invalidates_preview(self):
        self.initial();self.write('other.txt','alpha\n');state=inspect(self.root,self.repo);self.write('other.txt','bravo\n')
        with self.assertRaisesRegex(ValueError,'repository changed'):execute(dict(root=str(self.root),directory=str(self.repo),action='stage',file='other.txt',revision=state['revision']))
        self.assertEqual(self.git('diff','--cached'),'')
    def test_branch_switch_and_conflict_refusal(self):
        self.initial();self.action('branch',branch='feature/queue');self.assertEqual(self.git('branch','--show-current'),'feature/queue');self.write('other.txt','branch\n');self.action('stage',file='other.txt');self.action('commit',message='branch content');self.action('switch',branch='main');self.write('other.txt','keep draft\n')
        with self.assertRaisesRegex(ValueError,'overwritten'):self.action('switch',branch='feature/queue')
        self.assertEqual((self.repo/'other.txt').read_text(),'keep draft\n')
        with self.assertRaises(ValueError):self.action('branch',branch='--orphan')
    def test_push_only_current_branch_even_with_mirror_setting(self):
        self.initial();remote=self.root/'origin.git';self.git('init','--bare','-q',str(remote),cwd=self.root);self.git('remote','add','origin',str(remote));self.git('push','-q','origin','main');original=self.git('rev-parse','main',cwd=remote)
        self.action('branch',branch='feature/queue');self.write('other.txt','feature\n');self.action('stage',file='other.txt');self.action('commit',message='feature');self.git('config','remote.origin.mirror','true');self.action('push',remote='origin')
        self.assertEqual(self.git('rev-parse','main',cwd=remote),original);self.assertEqual(self.git('rev-parse','feature/queue',cwd=remote),self.git('rev-parse','HEAD'))
    def test_stale_remote_and_outside_paths_are_refused(self):
        self.initial();self.git('remote','add','origin','https://user:private@example.invalid/old.git');state=inspect(self.root,self.repo);self.assertEqual(state['remotes'][0]['urls'],['https://example.invalid/old.git']);self.git('remote','set-url','origin','https://example.invalid/new.git')
        with self.assertRaisesRegex(ValueError,'repository changed'):execute(dict(root=str(self.root),directory=str(self.repo),action='push',remote='origin',revision=state['revision']))
        with self.assertRaisesRegex(ValueError,'outside'):inspect(self.repo/'nested',self.repo/'nested')
        with self.assertRaises(ValueError):self.action('stage',file='../outside.txt')
    def test_mutations_honor_repository_hooks_and_errors_preserve_index(self):
        self.initial();hooks=self.repo/'.git'/'hooks';hooks.mkdir(exist_ok=True);hook=hooks/'pre-commit';hook.write_text('#!/bin/sh\nprintf checked > hook-ran.txt\nexit 1\n',encoding='utf-8');hook.chmod(0o755);self.git('config','core.hooksPath',str(hooks));self.write('other.txt','changed\n');self.action('stage',file='other.txt')
        with self.assertRaises(ValueError):self.action('commit',message='Hook must refuse')
        self.assertTrue((self.repo/'hook-ran.txt').exists());self.assertEqual(self.git('show',':other.txt'),'changed');self.assertEqual(self.git('log','-1','--format=%s'),'base')

if __name__=='__main__':unittest.main()
